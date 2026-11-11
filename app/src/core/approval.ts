/**
 * 审批闸门：宿主机命令在跑之前，先发到配置的审批聊天（审批房或私聊），等一句话。
 *
 * 三条硬规矩：
 *   1. 超时 = 拒绝（fail-closed），不是默认放行
 *   2. 只有贴在审批提示上的 OK / No 表情算数；同一聊天里的正常消息照常进她的会话
 *   3. 一次只留一条待审，表情必须贴在对应那条提示上，避免批错
 */
import fs from "node:fs";
import path from "node:path";
import type { InboundMessage } from "../types.ts";
import type { Logger } from "./logger.ts";
import type { Store } from "./db.ts";
import { ApprovalConflictError, createApproval, decideApproval } from "./approvals.ts";

export type Decision = "approved" | "rejected" | "timeout" | "disabled";

export interface ApprovalConfig {
  enabled: boolean;
  /** 从哪个平台发（matrix / feishu） */
  platform: string;
  /** 审批聊天的 external chat id（审批房或私聊） */
  roomId: string;
  /** 只有这些人能批；空 = 谁都不能批 */
  ownerIds: string[];
  /** 超时毫秒数，超时按拒绝 */
  timeoutMs: number;
  /** 裁决后和执行完各回一句状态到审批房（默认 true） */
  notify?: boolean;
}

export interface ApprovalResult {
  /** 这条审批的序号，执行完回报结果时要用它指认 */
  id: number;
  decision: Decision;
  /** 批/拒的人 */
  by?: string;
  latencyMs: number;
}

interface Pending {
  id: number;
  cmd: string;
  why: string;
  createdAt: number;
  resolve: (r: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 这条审批提示本身的事件 id：只认贴在这条上的表情 */
  promptEventId?: string | null;
  /** approvals 表里的行 id；落库失败时为空，退回纯内存审批 */
  approvalRowId?: number;
}

/** 落库/唤醒依赖；不传就是原来的纯内存闸门（测试与未接线场景）。 */
export interface ApprovalGateDeps {
  store?: Store;
  /** 新申请 / 拒绝后的 pending tick 唤醒 */
  enqueue?: () => void;
  /** 落库时的任务 id，默认 0（不挂具体任务） */
  taskId?: number;
  /** 落库时的 worker id，默认 "host" */
  workerId?: string;
}

/** 审批只认两个表情：OK = 允许，No = 拒绝。别的表情一律当聊天放行。 */
export function reactionDecision(key: string): Decision | null {
  const k = key.replace(/[\uFE0F\uFE0E]/g, "").trim().toLowerCase();
  if (k === "ok" || k === "👍") return "approved";
  if (k === "no" || k === "👎") return "rejected";
  return null;
}

/** 审批超时用的人话：天 / 小时 / 分钟 / 秒。 */
export function humanTimeout(ms: number): string {
  if (ms >= 86400_000) return `${Math.max(1, Math.round(ms / 86400_000))} 天`;
  if (ms >= 3600_000) return `${Math.max(1, Math.round(ms / 3600_000))} 小时`;
  if (ms >= 60_000) return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
  return `${Math.max(1, Math.round(ms / 1000))} 秒`;
}

export class ApprovalGate {
  private seq = 0;
  private pending: Pending | null = null;
  /** 串行链：上一次裁决完才发下一条 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private cfg: ApprovalConfig,
    private log: Logger,
    /** 往审批聊天发一条系统通知（不经过池、不入她的对话） */
    private send: (
      chatId: string,
      text: string,
    ) => Promise<{ ok: boolean; error?: string; msgId?: string }>,
    private logFile?: string,
    /** 落库与 pending tick；不给就是纯内存闸门 */
    private deps: ApprovalGateDeps = {},
  ) {
    // 序号要从账本接着数：重启后重新从 #1 开始，「y 1」就会批到一条新命令上
    if (this.logFile) {
      try {
        const lines = fs.readFileSync(this.logFile, "utf8").split("\n").filter(Boolean);
        for (const l of lines) {
          try { this.seq = Math.max(this.seq, Number(JSON.parse(l).id) || 0); } catch { /* 坏行跳过 */ }
        }
      } catch { /* 还没有账本 */ }
    }
  }

  get enabled(): boolean {
    return !!this.cfg?.enabled && !!this.cfg?.roomId && (this.cfg.ownerIds ?? []).length > 0;
  }

  /** 等待中的审批（测试与状态查询用） */
  get waiting(): { id: number; cmd: string; elapsedMs: number } | null {
    if (!this.pending) return null;
    return { id: this.pending.id, cmd: this.pending.cmd, elapsedMs: Date.now() - this.pending.createdAt };
  }

  async request(req: { cmd: string; cwd: string; why: string; taskId?: number }): Promise<ApprovalResult> {
    if (!this.enabled) return { id: 0, decision: "disabled", latencyMs: 0 };
    const run = () => this.ask(req);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private ask(req: { cmd: string; cwd: string; why: string; taskId?: number }): Promise<ApprovalResult> {
    const id = ++this.seq;
    const createdAt = Date.now();
    const timeoutMs = Math.max(500, this.cfg.timeoutMs || 600_000);
    const oneLine = req.cmd.replace(/\s+/g, " ").slice(0, 400);
    const text = [
      `【要动本机】#${id}（${req.why}）`,
      `命令：${oneLine}`,
      "",
      "同意：给这条消息贴 OK / 👍 表情",
      "拒绝：贴 No / 👎 表情",
      `（超时 ${humanTimeout(timeoutMs)} 不回＝拒绝；这是系统审批消息，贴表情即可，不用在这里回复）`,
    ].join("\n");

    // 内存 Pending 同时落库：重启后 GET /v1/approvals 还能看到、还能裁决
    let approvalRowId: number | undefined;
    if (this.deps.store) {
      try {
        const a = createApproval(this.deps.store, {
          taskId: req.taskId ?? this.deps.taskId ?? 0,
          workerId: this.deps.workerId ?? "host",
          action: `shell: ${oneLine}`,
          detail: req.cwd,
          why: req.why,
          timeoutS: timeoutMs / 1000,
        }, this.deps.enqueue);
        approvalRowId = a.id;
      } catch (e) {
        this.log.warn(`审批 #${id} 落库失败（继续走内存审批）：${(e as Error).message}`);
      }
    }

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => this.settle(id, "timeout"), timeoutMs);
      this.pending = { id, cmd: req.cmd, createdAt, why: req.why, resolve, timer, approvalRowId };

      this.send(this.cfg.roomId, text).then((r) => {
        if (!r.ok) {
          this.log.warn(`审批 #${id} 发不出去：${r.error ?? "未知原因"}，按拒绝处理`);
          this.settle(id, "rejected");
          return;
        }
        // 记下提示事件 id：表情必须贴在这一条上才算数
        if (this.pending && this.pending.id === id) this.pending.promptEventId = r.msgId ?? null;
      });
    });
  }

  /** 唯一的裁决入口：超时 / 同意 / 拒绝 / 发不出去，都走这里 */
  private settle(id: number, decision: Decision, by?: string): void {
    const p = this.pending;
    if (!p || p.id !== id) return;
    clearTimeout(p.timer);
    this.pending = null;
    const latencyMs = Date.now() - p.createdAt;
    this.note({ ts: p.createdAt, id, cmd: p.cmd, why: p.why, decision, by: by ?? null, latencyMs });
    this.log.info(`审批 #${id} ${decision}${by ? ` by ${by}` : ""} ${latencyMs}ms：${p.cmd.replace(/\s+/g, " ").slice(0, 80)}`);

    // 同一张表：审批房里的裁决也写 approvals；UFA 工具裁决走同一个 decideApproval。
    // timeout 不在这里写——expires_at 和定时器同一时刻到，交给 sweepExpirations 收口。
    if (this.deps.store && p.approvalRowId) {
      if (decision === "approved" || decision === "rejected") {
        try {
          decideApproval(this.deps.store, p.approvalRowId, { decision, by: by ?? "system" }, this.deps.enqueue);
        } catch (e) {
          // 已经被 UFA 或 sweeper 裁决过了：内存里这条照常按本地结果返回，别改坏已经落定的状态
          if (!(e instanceof ApprovalConflictError)) {
            this.log.warn(`审批 #${id} 落库失败：${(e as Error).message}`);
          }
        }
      }
    }

    // 回一句状态到审批房：他刚点了按钮，得看到这一下有没有落上
    if (this.cfg.notify !== false) {
      const secs = (latencyMs / 1000).toFixed(0);
      const line =
        decision === "approved" ? `#${id} 已批准（${by ?? "系统"}，${secs}s），开始执行`
        : decision === "rejected" ? `#${id} 已拒绝，没有执行`
        : decision === "timeout" ? `#${id} 超时 ${secs}s，按拒绝处理，没有执行`
        : `#${id} 关掉了审批，没有执行`;
      void this.send(this.cfg.roomId, line).catch(() => undefined);
    }
    p.resolve({ id, decision, by, latencyMs });
  }

  /** 命令跑完了，回一句结果到审批房（只对过了审批的那条有意义） */
  reportDone(id: number, info: { ok: boolean; code: number; ms: number }): void {
    if (!this.enabled || !id || this.cfg.notify === false) return;
    const secs = (info.ms / 1000).toFixed(1);
    const line = info.ok
      ? `#${id} 执行完成（${secs}s）`
      : `#${id} 执行失败：退出码 ${info.code}（${secs}s）`;
    void this.send(this.cfg.roomId, line).catch(() => undefined);
  }

  /**
   * 入站消息先过这里。返回 true = 这条是贴在审批提示上的 OK / No 表情，已被吃掉。
   * 没有待审批、贴错消息、别的表情、文字聊天，一律返回 false，消息照常入池。
   */
  tryHandle(m: InboundMessage): boolean {
    if (!this.enabled) return false;
    if (!this.cfg?.roomId || m.external_chat_id !== this.cfg.roomId) return false;
    const p = this.pending;
    if (!p) return false;
    if (m.from_self) return false;
    if (!(this.cfg.ownerIds ?? []).includes(m.sender_id)) return false;
    if (m.media_type !== "reaction") return false;

    const decision = reactionDecision(m.reaction_key ?? "");
    if (!decision) return false;
    const onPrompt = !p.promptEventId || !m.reaction_to || m.reaction_to === p.promptEventId;
    if (!onPrompt) return false;
    this.settle(p.id, decision, m.sender_id);
    return true;
  }

  /** 账：一行一条，事后能回放「那天她为什么动了这个目录」 */
  private note(rec: Record<string, unknown>) {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(rec) + "\n", "utf8");
    } catch (e) {
      this.log.warn(`审批账写不进去：${(e as Error).message}`);
    }
  }
}
