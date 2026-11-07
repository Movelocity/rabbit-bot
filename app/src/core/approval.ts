/**
 * 审批闸门：宿主机命令在跑之前，先发到主人的 Matrix 审批房，等一句话。
 *
 * 三条硬规矩：
 *   1. 超时 = 拒绝（fail-closed），不是默认放行
 *   2. 审批消息**不进她的会话上下文**——那是系统在跟主人说话，不是聊天素材
 *   3. 一次只留一条待审，回「y 12」带序号也能对上，避免连点 y 批错东西
 */
import fs from "node:fs";
import path from "node:path";
import type { InboundMessage } from "../types.ts";
import type { Logger } from "./logger.ts";

export type Decision = "approved" | "rejected" | "timeout" | "disabled";

export interface ApprovalConfig {
  enabled: boolean;
  /** 从哪个平台发（matrix / feishu） */
  platform: string;
  /** 审批房的 external chat id */
  roomId: string;
  /** 只有这些人能批；空 = 谁都不能批 */
  ownerIds: string[];
  /** 超时毫秒数，超时按拒绝 */
  timeoutMs: number;
}

export interface ApprovalResult {
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
}

const YES = /^(y|ye|yes|ok|好|好的|同意|批准|可以|行)\b/i;
const NO = /^(n|no|不|不行|不要|拒绝|否)\b/i;

export class ApprovalGate {
  private seq = 0;
  private pending: Pending | null = null;
  /** 串行链：上一次裁决完才发下一条 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private cfg: ApprovalConfig,
    private log: Logger,
    /** 往审批房发一条系统通知（不经过池、不入她的对话） */
    private send: (chatId: string, text: string) => Promise<{ ok: boolean; error?: string }>,
    private logFile?: string,
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

  async request(req: { cmd: string; cwd: string; why: string }): Promise<ApprovalResult> {
    if (!this.enabled) return { decision: "disabled", latencyMs: 0 };
    const run = () => this.ask(req);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private ask(req: { cmd: string; cwd: string; why: string }): Promise<ApprovalResult> {
    const id = ++this.seq;
    const createdAt = Date.now();
    const timeoutMs = Math.max(500, this.cfg.timeoutMs || 600_000);
    const oneLine = req.cmd.replace(/\s+/g, " ").slice(0, 400);
    const text = [
      `【要动本机】#${id}（${req.why}）`,
      oneLine,
      `同意回 y ${id}　拒绝回 n ${id}　（${Math.round(timeoutMs / 1000)} 秒内不回＝拒绝）`,
    ].join("\n");

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => this.settle(id, "timeout"), timeoutMs);
      this.pending = { id, cmd: req.cmd, createdAt, why: req.why, resolve, timer };

      this.send(this.cfg.roomId, text).then((r) => {
        if (!r.ok) {
          this.log.warn(`审批 #${id} 发不出去：${r.error ?? "未知原因"}，按拒绝处理`);
          this.settle(id, "rejected");
        }
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
    p.resolve({ decision, by, latencyMs });
  }

  /**
   * 入站消息先过这里。返回 true = 这条被闸门吃掉了，不要入池、不要给她看。
   * 审批房里的一切都不进她的上下文——包括没头没脑的「y」和闲聊。
   */
  tryHandle(m: InboundMessage): boolean {
    if (!this.cfg?.roomId || m.external_chat_id !== this.cfg.roomId) return false;
    // 自己发的、以及审批房里的所有消息，一律吞掉
    if (m.from_self) return true;

    const who = m.sender_id;
    if (!(this.cfg.ownerIds ?? []).includes(who)) {
      this.log.warn(`审批房里有非主人的消息，忽略：${who}`);
      return true;
    }
    const p = this.pending;
    if (!p) return true;

    const text = (m.text ?? "").trim();
    // 带序号就核对序号，防止「y」批到上一条
    const num = text.match(/\b(\d{1,6})\b/)?.[1];
    if (num && Number(num) !== p.id) {
      this.log.info(`审批 #${p.id}：收到针对 #${num} 的回复，忽略`);
      return true;
    }
    if (YES.test(text)) { this.settle(p.id, "approved", who); return true; }
    if (NO.test(text)) { this.settle(p.id, "rejected", who); return true; }
    // 说了别的：当聊天，吞掉但不裁决
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
