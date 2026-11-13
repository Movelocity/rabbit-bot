/**
 * 出站消息审核：agent 往聊天池发消息前，先把内容发到审批聊天，主人贴 OK / No 裁决。
 *
 * 硬规矩：
 *   1. 超时 = 不发送（fail-closed），不是默认放行
 *   2. 预览和裁决都走系统消息，不进池、不进她的上下文；只有被本闸门认领的表情
 *      才不落池，同一聊天里的正常文字照常入池
 *   3. 每条消息独立提交、独立裁决（UDP，不排队等前一条）；表情按它贴的预览消息匹配，
 *      平台没给 reaction_to 时只有唯一一条待审才敢认
 *   4. 同一条消息重复提交（模型重试）只保留一条，不会因为重试发出双份
 *   5. 重启后待审不恢复：宁可漏发，也不把没审过的内容补发出去
 *   6. 提交即返回：审核在后台跑，agent 这一轮不会被审批拖住
 */
import type { Config } from "../config.ts";
import type { InboundMessage } from "../types.ts";
import type { Logger } from "./logger.ts";
import { humanTimeout, reactionDecision } from "./approval.ts";

export type ReviewDecision = "approved" | "rejected" | "timeout";

/**
 * 连接与投递配置。注意：这里没有「总开关」和「哪些池要审核」——那是
 * cfg.sendReview.enabled / defaultReview / overrides，由 App 在每次发送时实时判断。
 * 闸门本身只关心「审批房配好没有」，配好就能审。
 */
export interface SendReviewConfig {
  /** matrix / feishu */
  platform: string;
  /** 审批聊天的 external chat id */
  roomId: string;
  /** 只有这些人能批；空 = 谁都不能批 */
  ownerIds: string[];
  /** 超时毫秒数，超时按不发送 */
  timeoutMs: number;
  /** 裁决后回一句状态到审批聊天（默认 true） */
  notify?: boolean;
  /** 预览里最多显示原消息多少字（默认 800） */
  previewMaxChars?: number;
}

export interface SendReviewRequest {
  /** 目标池所在平台 */
  platform: string;
  /** 目标池的 external chat id */
  chatId: string;
  /** 目标池引用（pool_id / 别名），日志用 */
  poolRef: string;
  /** 目标池标题，预览里给人看 */
  poolTitle: string;
  /** private / group / task / schedule */
  kind: string;
  /** 待发送的原文 */
  content: string;
  /** 审核通过后真正执行发送；返回发送结果 */
  deliver: () => Promise<{ ok: boolean; error?: string }>;
  /** 审核未通过（驳回 / 超时）时通知目标池，让 agent 知道这条没发出去 */
  notifyUnsent?: (decision: ReviewDecision) => void;
}

export interface ProposeResult {
  /** true = 已进审核队列（还没发给目标聊天） */
  queued: boolean;
  /** 审核序号，工具返回值里带上，便于对账 */
  id?: number;
  /** queued=false 时的原因；调用方不得继续发送 */
  error?: string;
}

export interface ReviewTarget {
  platform: string;
  chatId: string;
}

interface Pending {
  id: number;
  req: SendReviewRequest;
  createdAt: number;
  /** 这条预览发到哪：主对话池或固定审批房 */
  target: ReviewTarget;
  /** 这条预览本身的消息 id：只认贴在这条上的表情 */
  promptEventId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 86_400_000;
const DEFAULT_PREVIEW_CHARS = 800;
/** 同时待审上限：agent 一次刷太多预览会淹审批聊天，超过就拒掉新的 */
const MAX_PENDING = 20;

/** 把 sendReview 和旧的 approval 配置合并成一份可执行配置：没填的字段复用审批房。 */
export function resolveSendReviewConfig(cfg: Config): SendReviewConfig {
  const own = cfg.sendReview;
  const approval = cfg.approval;
  return {
    platform: String(own?.platform ?? "").trim() || String(approval?.platform ?? "").trim(),
    roomId: String(own?.roomId ?? "").trim() || String(approval?.roomId ?? "").trim(),
    ownerIds: (own?.ownerIds ?? []).length ? own!.ownerIds! : (approval?.ownerIds ?? []),
    timeoutMs: own?.timeoutMs ?? approval?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    notify: own?.notify,
    previewMaxChars: own?.previewMaxChars,
  };
}

/**
 * 审批去处和主人配好没有；没配好时闸门会 fail-closed（propose 直接报错）。
 * 有主对话池时把审批消息发到主对话，不再要求单独配 roomId。
 */
export function sendReviewReady(cfg: Config): boolean {
  const c = resolveSendReviewConfig(cfg);
  const hasTarget = !!c.roomId || !!String(cfg.sendReview?.primaryPoolId ?? "").trim();
  return hasTarget && (c.ownerIds ?? []).length > 0;
}

function kindLabel(kind: string): string {
  if (kind === "group") return "群聊";
  if (kind === "private") return "私聊";
  if (kind === "task") return "任务群";
  if (kind === "schedule") return "日程";
  return kind || "聊天";
}

export class SendReviewGate {
  private seq = 0;
  /** 所有已提交、还没裁决的提案；彼此独立，不排队等前一条 */
  private pending = new Map<number, Pending>();

  constructor(
    private cfg: SendReviewConfig,
    private log: Logger,
    /** 往审批聊天发一条系统通知（不经过池、不入她的对话） */
    private send: (target: ReviewTarget, text: string) => Promise<{ ok: boolean; error?: string; msgId?: string }>,
    /** 主对话池解析：配了就用它收审批消息，没配再退回固定审批房 */
    private resolvePrimaryTarget?: () => ReviewTarget | null,
  ) {}

  /** 预览发到哪：主对话优先，其次固定审批房。 */
  private target(): ReviewTarget | null {
    return this.resolvePrimaryTarget?.() ?? (this.cfg?.roomId ? { platform: this.cfg.platform, chatId: this.cfg.roomId } : null);
  }

  /** 审批去处和主人是否配好。总开关在 App 侧判断，不在这里。 */
  get enabled(): boolean {
    return (this.cfg.ownerIds ?? []).length > 0 && !!this.target();
  }

  /** 所有等裁决的提案（状态查询用） */
  get waiting(): { id: number; poolRef: string }[] {
    return [...this.pending.values()].map((p) => ({ id: p.id, poolRef: p.req.poolRef }));
  }

  /**
   * 提交一条待发消息。成功只代表「已进审核队列」，不代表已发送；
   * 真正发出去是在主人贴 OK 之后，由 gate 调 req.deliver()。
   * 这里发完预览就返回，不等裁决，也不等其他提案——脱手，agent 继续干活。
   */
  async propose(req: SendReviewRequest): Promise<ProposeResult> {
    const target = this.target();
    if (!target || !(this.cfg.ownerIds ?? []).length) {
      return { queued: false, error: "发送审核没配好（缺少审批会话 / ownerIds），这条没有发" };
    }
    // 模型有时会对着同一个内容重试；同一条已经在队列里就不再发一遍预览
    const dup = this.findDuplicate(req);
    if (dup) return { queued: true, id: dup.id };
    if (this.pending.size >= MAX_PENDING) {
      return { queued: false, error: `审核队列已满（${MAX_PENDING} 条待审），这条没有发` };
    }

    const p: Pending = { id: ++this.seq, req, target, createdAt: Date.now(), promptEventId: null, timer: null };
    this.pending.set(p.id, p);
    void this.publish(p);
    return { queued: true, id: p.id };
  }

  private findDuplicate(req: SendReviewRequest): Pending | null {
    for (const p of this.pending.values()) {
      if (p.req.poolRef === req.poolRef && p.req.content === req.content) return p;
    }
    return null;
  }

  /** 把预览发出去并挂上超时；失败就按拒绝收口。后台跑，不阻塞提交方。 */
  private async publish(p: Pending): Promise<void> {
    const timeoutMs = Math.max(1000, this.cfg.timeoutMs || DEFAULT_TIMEOUT_MS);
    p.timer = setTimeout(() => this.settle(p, "timeout"), timeoutMs);
    (p.timer as any).unref?.();

    const r: { ok: boolean; error?: string; msgId?: string } = await this.send(
      p.target,
      this.format(p, timeoutMs),
    ).catch((e) => ({ ok: false, error: (e as Error).message }));

    // 预览还没发出去就已经超时 / 被别的路径收口：不要再改状态
    if (this.pending.get(p.id) !== p) return;
    if (!r.ok) {
      this.log.warn(`发送审核 #${p.id} 预览发不出去：${r.error ?? "未知原因"}，这条不发`);
      this.settle(p, "rejected");
      return;
    }
    p.promptEventId = r.msgId ?? null;
  }

  /** 唯一的裁决入口：超时 / 同意 / 拒绝都走这里。 */
  private settle(p: Pending, decision: ReviewDecision, by?: string): void {
    if (this.pending.get(p.id) !== p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(p.id);
    const latencyMs = Date.now() - p.createdAt;
    this.log.info(`发送审核 #${p.id} ${decision}${by ? ` by ${by}` : ""} ${latencyMs}ms → ${p.req.poolRef}`);
    void this.finish(p, decision, latencyMs);
  }

  private async finish(p: Pending, decision: ReviewDecision, latencyMs: number): Promise<void> {
    if (decision === "approved") {
      let r: { ok: boolean; error?: string };
      try {
        r = await p.req.deliver();
      } catch (e) {
        r = { ok: false, error: (e as Error).message };
      }
      if (r.ok) {
        this.log.info(`发送审核 #${p.id} 已放行并发出 → ${p.req.poolRef}`);
      } else {
        this.log.error(`发送审核 #${p.id} 已通过但发送失败：${r.error ?? "未知原因"}`);
      }
      if (this.cfg.notify !== false) {
        const secs = (latencyMs / 1000).toFixed(0);
        const line = r.ok
          ? `#${p.id} 已批准并发送到「${p.req.poolTitle}」（${secs}s）`
          : `#${p.id} 已批准，但发送失败：${r.error ?? "未知原因"}`;
        await this.send(p.target, line).catch(() => undefined);
      }
      return;
    }

    // 目标池也要留痕：这条没发出去，agent 下一轮读池时得知道，不能当成已经说过了
    try {
      p.req.notifyUnsent?.(decision);
    } catch (e) {
      this.log.warn(`发送审核 #${p.id} 未通过事件写入失败：${(e as Error).message}`);
    }

    if (this.cfg.notify !== false) {
      const line = decision === "timeout"
        ? `#${p.id} 超时未裁决，按不发送处理（「${p.req.poolTitle}」）`
        : `#${p.id} 已驳回，不发送（「${p.req.poolTitle}」）`;
      await this.send(p.target, line).catch(() => undefined);
    }
  }

  private format(p: Pending, timeoutMs: number): string {
    const max = this.cfg.previewMaxChars ?? DEFAULT_PREVIEW_CHARS;
    const raw = p.req.content;
    const content = raw.length > max ? `${raw.slice(0, max)}…` : raw;
    return [
      `【发送审核】#${p.id} → ${kindLabel(p.req.kind)}「${p.req.poolTitle}」`,
      "内容：",
      content,
      "",
      "同意发送：给这条消息贴 OK / 👍 表情",
      "不发送：贴 No / 👎 表情",
      `（超时 ${humanTimeout(timeoutMs)} 不回＝不发送；这是系统审核消息，贴表情即可，不用在这里回复）`,
    ].join("\n");
  }

  /**
   * 入站消息先过这里。返回 true = 这条是贴在本闸门预览上的 OK / No 表情，已被吃掉。
   * 没有待审、贴错消息、别的表情、文字聊天，一律返回 false，消息照常入池。
   */
  tryHandle(m: InboundMessage): boolean {
    if (m.from_self) return false;
    if (!(this.cfg.ownerIds ?? []).includes(m.sender_id)) return false;
    if (m.media_type !== "reaction") return false;

    const decision = reactionDecision(m.reaction_key ?? "");
    if (decision !== "approved" && decision !== "rejected") return false;

    const p = this.findPending(m);
    if (!p) return false;
    this.settle(p, decision, m.sender_id);
    return true;
  }

  /** 按表情贴的那条预览找提案；平台没给 reaction_to 时，只有唯一一条候选才敢认。 */
  private findPending(m: InboundMessage): Pending | null {
    const candidates = [...this.pending.values()].filter(
      (p) => p.target.platform === m.platform && p.target.chatId === m.external_chat_id,
    );
    if (!candidates.length) return null;
    if (m.reaction_to) {
      return candidates.find((p) => p.promptEventId === m.reaction_to) ?? null;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }
}
