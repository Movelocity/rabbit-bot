/**
 * 任务审批闸门：UFA 建好的任务先发审批提示，主人贴 OK / No 表情裁决。
 *
 * 硬规矩：
 *   1. 超时 = 拒绝（fail-closed），不是默认放行
 *   2. 审批提示走系统消息、不进池；只有被闸门认领的裁决动作不进她的会话，
 *      同一聊天里的正常文字照常入池——审批房可能就是私聊，不能整房吞消息
 *   3. 一条任务对应一条提示消息，表情必须贴在那条上，避免多任务时批错
 */
import type { InboundMessage } from "../types.ts";
import type { Logger } from "./logger.ts";
import { taskDisplayName, type Task } from "./tasks.ts";
import { humanTimeout, reactionDecision } from "./approval.ts";

export interface TaskApprovalConfig {
  enabled: boolean;
  /** 从哪个平台发（feishu / matrix） */
  platform: string;
  /** 固定审批聊天的 external chat id（target=room 或 origin 找不到时用） */
  roomId: string;
  /** 只有这些人能批；空 = 谁都不能批 */
  ownerIds: string[];
  /** 超时毫秒数，超时按拒绝 */
  timeoutMs: number;
  /** 裁决后回一句状态到原聊天/审批房（默认 true） */
  notify?: boolean;
}

export interface TaskApprovalOutcome {
  ok: boolean;
  /** 回给发起聊天/审批房的一句话；空 = 不回 */
  text?: string;
}

/** 一条任务审批提示发到哪：可以是任务发起的聊天，也可以是固定审批房。 */
export interface TaskApprovalTarget {
  platform: string;
  chatId: string;
}

export interface TaskApprovalHooks {
  onApprove(task: Task, by: string): Promise<TaskApprovalOutcome> | TaskApprovalOutcome;
  onReject(task: Task, by: string): Promise<TaskApprovalOutcome> | TaskApprovalOutcome;
  onTimeout(task: Task): Promise<TaskApprovalOutcome> | TaskApprovalOutcome;
}

interface Pending {
  task: Task;
  target: TaskApprovalTarget;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** 这条审批提示本身的消息 id：只认贴在这条上的表情 */
  promptEventId: string | null;
}

const DEFAULT_TIMEOUT_MS = 24 * 3600_000;

function clip(s: string, n: number): string {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 审批标题用完整任务名；模型偶尔把任务号写进 name，去掉避免出现两个 #id。 */
function approvalTitle(task: Task): string {
  const name = taskDisplayName(task);
  const withoutId = name.replace(new RegExp(`^#\\s*${task.id}(?:\\s+|$)`), "").trim();
  return withoutId || clip(task.goal, 120) || name;
}

/** 任务审批提示：只放主人做决定需要看的信息，太长就截。 */
export function formatTaskApprovalText(task: Task, timeoutMs: number): string {
  const line = (label: string, value: string, max = 300) => {
    const t = clip(value, max);
    return t ? `${label}：${t}` : "";
  };
  return [
    `【任务待审批】#${task.id} ${approvalTitle(task)}`,
    line("目标", task.goal),
    `目录：${clip(task.work_dir, 300)}`,
    `执行器：${task.executor || "opencode"}${task.model ? ` · 模型 ${clip(task.model, 80)}` : ""}`,
    "",
    "同意：给这条消息贴 OK / 👍 表情",
    "拒绝：贴 No / 👎 表情",
    `（超时 ${humanTimeout(timeoutMs)} 不回＝拒绝；这是系统审批消息，贴表情即可，不用在这里回复）`,
  ].filter((x) => x !== "").join("\n");
}

export class TaskApprovalGate {
  private pending = new Map<number, Pending>();

  constructor(
    private cfg: TaskApprovalConfig,
    private log: Logger,
    /** 往发起聊天/审批房发一条系统通知（不经过池、不入她的对话） */
    private send: (
      target: TaskApprovalTarget,
      text: string,
    ) => Promise<{ ok: boolean; error?: string; msgId?: string }>,
    private hooks: TaskApprovalHooks,
  ) {}

  get enabled(): boolean {
    return !!this.cfg?.enabled && (this.cfg.ownerIds ?? []).length > 0;
  }

  /** 正在等审批的任务 id（状态查询/测试用） */
  get waiting(): number[] {
    return [...this.pending.keys()];
  }

  /**
   * 发一条任务审批请求。target 不传就用配置里的固定审批房（兼容旧用法）。
   * 返回 false 表示没发出去（任务仍停在 pending_approval）。
   * 调用方不用等裁决——裁决到了由 hooks 处理。
   */
  async notify(task: Task, target?: TaskApprovalTarget): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.pending.has(task.id)) return true;

    const to = target ?? (this.cfg.roomId
      ? { platform: this.cfg.platform, chatId: this.cfg.roomId }
      : null);
    if (!to) {
      this.log.warn(`任务 #${task.id} 没有可用的审批目标（target=origin 但找不到发起聊天，roomId 也为空）`);
      return false;
    }

    const timeoutMs = Math.max(1000, this.cfg.timeoutMs || DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => this.onTimeout(task.id), timeoutMs);
    (timer as any).unref?.();
    const p: Pending = { task, target: to, createdAt: Date.now(), timer, promptEventId: null };
    this.pending.set(task.id, p);

    const r = await this.send(to, formatTaskApprovalText(task, timeoutMs));
    if (!r.ok) {
      clearTimeout(timer);
      this.pending.delete(task.id);
      this.log.warn(`任务 #${task.id} 审批消息发不出去：${r.error ?? "未知原因"}（任务仍停在 pending_approval）`);
      return false;
    }
    if (this.pending.get(task.id) === p) p.promptEventId = r.msgId ?? null;
    this.log.info(`任务 #${task.id}「${taskDisplayName(task)}」已发到 ${to.platform}:${to.chatId}，等主人裁决`);
    return true;
  }

  /** 任务已经在别处批过/取消：把这条待审忘掉，避免之后误裁决或超时刷屏。 */
  cancel(taskId: number): void {
    const p = this.pending.get(taskId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(taskId);
  }

  private onTimeout(taskId: number): void {
    const p = this.pending.get(taskId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(taskId);
    this.log.info(`任务 #${taskId} 审批超时，按拒绝处理`);
    void this.runHook(p.task, p.target, "timeout");
  }

  private decide(taskId: number, decision: "approved" | "rejected", by: string): void {
    const p = this.pending.get(taskId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(taskId);
    this.log.info(`任务 #${taskId} 审批 ${decision} by ${by}（${Date.now() - p.createdAt}ms）`);
    void this.runHook(p.task, p.target, decision, by);
  }

  private async runHook(
    task: Task,
    target: TaskApprovalTarget,
    decision: "approved" | "rejected" | "timeout",
    by?: string,
  ): Promise<void> {
    let out: TaskApprovalOutcome;
    try {
      out = decision === "approved"
        ? await this.hooks.onApprove(task, by ?? "system")
        : decision === "rejected"
          ? await this.hooks.onReject(task, by ?? "system")
          : await this.hooks.onTimeout(task);
    } catch (e) {
      out = { ok: false, text: `任务 #${task.id} 裁决处理失败：${(e as Error).message}` };
    }
    if (this.cfg.notify === false || !out?.text) return;
    await this.send(target, out.text).catch(() => undefined);
  }

  /**
   * 入站消息先过这里。返回 true = 这条是贴在任务审批提示上的 OK / No 表情，已被吃掉。
   * 别的消息一律返回 false，照常走原来的池/审批链路。
   */
  tryHandle(m: InboundMessage): boolean {
    if (!this.enabled) return false;
    if (m.from_self) return false;
    if (!(this.cfg.ownerIds ?? []).includes(m.sender_id)) return false;
    if (m.media_type !== "reaction") return false;

    const decision = reactionDecision(m.reaction_key ?? "");
    if (decision !== "approved" && decision !== "rejected") return false;

    const p = this.findPending(m.reaction_to ?? null);
    if (!p) return false;
    // 表情必须贴在发出去的那条提示上，且来自提示所在的那个聊天
    if (m.platform !== p.target.platform || m.external_chat_id !== p.target.chatId) return false;
    this.decide(p.task.id, decision, m.sender_id);
    return true;
  }

  private findPending(reactionTo: string | null): Pending | null {
    if (reactionTo) {
      for (const p of this.pending.values()) if (p.promptEventId === reactionTo) return p;
      return null;
    }
    // 平台没给被贴的消息 id 时，只有唯一一条待审才敢认
    return this.pending.size === 1 ? [...this.pending.values()][0] : null;
  }
}
