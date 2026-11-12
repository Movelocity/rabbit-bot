/**
 * 发完消息后的看门狗：agent 在池里说完最后一句，静默 delayMs 没有新消息，
 * 就复核这句是不是「万事俱备，只欠用户点头」。是的话插一条系统消息并立即唤醒。
 *
 * 只做定时和防重；判断由 App 里的独立临时会话完成（prompt/watchdog.md）。
 * 与 Scheduler 里按墙上时间补触发定时器的 watchdogMs 不是一回事。
 */
import type { Clock } from "./clock.ts";
import type { Store } from "./db.ts";
import type { Logger } from "./logger.ts";
import type { StoredMessage } from "../types.ts";
import type { WatchdogSettings } from "../ops/watchdog-settings.ts";

export interface WatchdogDecision {
  execute: boolean;
  reason: string;
}

export interface AgentWatchdogDeps {
  clock: Clock;
  store: Store;
  log: Logger;
  settings: () => WatchdogSettings;
  isPaused: () => boolean;
  /** 单独起会话复核；失败/说不清返回 null，按不放行处理 */
  review: (poolId: string, lastSelf: StoredMessage) => Promise<WatchdogDecision | null>;
  /** 往池里插系统消息并立即唤醒 */
  nudge: (poolId: string, reason: string) => void;
}

interface Pending {
  timer: unknown;
  seq: number;
}

export class AgentWatchdog {
  private timers = new Map<string, Pending>();
  private lastNudgeAt = new Map<string, number>();

  constructor(private d: AgentWatchdogDeps) {}

  /** chat send 成功后调用；同池后发消息会重置计时 */
  onSent(poolId: string, seq: number, now = this.d.clock.now()): void {
    const settings = this.d.settings();
    if (!settings.enabled || !seq) {
      this.cancel(poolId);
      return;
    }
    const pool = this.d.store.getPool(poolId);
    if (!pool || pool.archived || pool.kind === "task" || pool.kind === "schedule") return;
    this.cancel(poolId);
    const pending: Pending = { seq, timer: null };
    pending.timer = this.d.clock.setTimeout(() => {
      if (this.timers.get(poolId) !== pending) return;
      this.timers.delete(poolId);
      void this.fire(poolId, seq, now).catch((e) => this.d.log.warn(`看门狗复核失败：${(e as Error).message}`));
    }, settings.delayMs);
    this.timers.set(poolId, pending);
  }

  cancel(poolId: string): void {
    const p = this.timers.get(poolId);
    if (!p) return;
    this.d.clock.clearTimeout(p.timer);
    this.timers.delete(poolId);
  }

  stop(): void {
    for (const [poolId] of this.timers) this.cancel(poolId);
    this.lastNudgeAt.clear();
  }

  private async fire(poolId: string, seq: number, sentAt: number): Promise<void> {
    const settings = this.d.settings();
    if (!settings.enabled || this.d.isPaused()) return;
    const pool = this.d.store.getPool(poolId);
    if (!pool || pool.archived || pool.kind === "task" || pool.kind === "schedule") return;

    // 10 秒里有人说话：用户已经接上了，不需要替她催自己
    const after = this.d.store.messagesAfter(poolId, seq).filter((m) => !m.from_self && !m.internal);
    if (after.length) return;
    // 她又发了新消息：旧计时器应该已经被 onSent 清掉；这里再核一次，避免异步竞态
    const lastSelf = this.d.store.lastSelfMessageRow(poolId);
    if (!lastSelf || lastSelf.seq !== seq || lastSelf.internal) return;

    const now = this.d.clock.now();
    const last = this.lastNudgeAt.get(poolId) ?? 0;
    if (settings.cooldownMs > 0 && now - last < settings.cooldownMs) return;

    const decision = await this.d.review(poolId, lastSelf);
    if (!decision?.execute) {
      if (decision) this.d.log.info(`看门狗：不放行 ${this.d.store.poolAlias(poolId)}（${decision.reason}）`);
      return;
    }

    // 复核是异步的，回来时可能已经有人说话 / 她又发了消息 / 被关掉
    if (!this.d.settings().enabled || this.d.isPaused()) return;
    const fresh = this.d.store.messagesAfter(poolId, seq).filter((m) => !m.from_self && !m.internal);
    const stillLast = this.d.store.lastSelfMessageRow(poolId);
    if (fresh.length || !stillLast || stillLast.seq !== seq) return;

    this.lastNudgeAt.set(poolId, now);
    this.d.log.info(`看门狗：放行 ${this.d.store.poolAlias(poolId)}（静默 ${Math.round((now - sentAt) / 1000)}s，${decision.reason}）`);
    this.d.nudge(poolId, decision.reason);
  }

  /** 测试/观测用 */
  pending(): string[] {
    return [...this.timers.keys()];
  }
}
