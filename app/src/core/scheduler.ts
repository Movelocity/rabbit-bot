/**
 * 调度器（纯代码）：
 * - tick：默认 3 分钟；活跃对话期间缩短为 activeTickMs，静默 activeWindowMs 后回到默认。
 *   tick 时有未读才唤醒（不调用 LLM 做判断），并检查计划时间表。
 * - 私聊新消息 / 群里被 @：进入去抖；最后一条后静默 debounceMs（且最长 debounceMaxWaitMs）再入队，不插队。
 * - 群里未被 @ 的消息：只在 tick 时被读到。
 */
import type { Clock } from "./clock.ts";
import { makeWake, type RunQueue } from "./queue.ts";
import type { Wake } from "../types.ts";

export interface SchedulerDeps {
  clock: Clock;
  queue: Pick<RunQueue, "enqueue">;
  isPaused: () => boolean;
  /** 有未读的池（tick 用） */
  poolsWithUnread: () => string[];
  /** 当前到期的计划触发（tick 用），由 PlanEngine 提供 */
  duePlans: (now: number) => Wake["planFires"];
  log?: (msg: string) => void;
}
export interface SchedulerConfig { tickMs: number; activeTickMs: number; activeWindowMs: number; debounceMs: number; debounceMaxWaitMs: number }

interface Debounce { timer: unknown; firstAt: number; count: number; reason: string }

export class Scheduler {
  private debounces = new Map<string, Debounce>();
  private tickTimer: unknown = null;
  private lastActivity = -Infinity;
  private running = false;
  constructor(private cfg: SchedulerConfig, private d: SchedulerDeps) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
  }
  stop() {
    this.running = false;
    if (this.tickTimer) this.d.clock.clearTimeout(this.tickTimer);
    this.tickTimer = null;
    for (const db of this.debounces.values()) this.d.clock.clearTimeout(db.timer);
    this.debounces.clear();
  }

  currentTickMs(): number {
    const now = this.d.clock.now();
    return now - this.lastActivity < this.cfg.activeWindowMs ? Math.min(this.cfg.activeTickMs, this.cfg.tickMs) : this.cfg.tickMs;
  }
  /** Agent 发送了消息 / 有人说话 → 视为活跃对话 */
  markActive() {
    const wasIdle = this.currentTickMs() === this.cfg.tickMs;
    this.lastActivity = this.d.clock.now();
    if (wasIdle && this.running && this.cfg.activeTickMs < this.cfg.tickMs) this.scheduleTick(); // 立即切换到短 tick
  }

  /** 新消息入池后调用。urgent = 私聊 或 群里 @我 */
  onMessage(poolId: string, urgent: boolean, reason: string) {
    this.markActive();
    if (!urgent) return; // 群里未 @：等 tick
    const now = this.d.clock.now();
    const prev = this.debounces.get(poolId);
    if (prev) this.d.clock.clearTimeout(prev.timer);
    const firstAt = prev?.firstAt ?? now;
    const remainingMax = firstAt + this.cfg.debounceMaxWaitMs - now;
    const delay = Math.max(0, Math.min(this.cfg.debounceMs, remainingMax));
    const db: Debounce = { timer: null, firstAt, count: (prev?.count ?? 0) + 1, reason: prev?.reason ?? reason };
    db.timer = this.d.clock.setTimeout(() => this.fireDebounce(poolId), delay);
    this.debounces.set(poolId, db);
  }
  isDebouncing(poolId: string) { return this.debounces.has(poolId); }

  private fireDebounce(poolId: string) {
    const db = this.debounces.get(poolId);
    this.debounces.delete(poolId);
    if (!db) return;
    if (this.d.isPaused()) { this.d.log?.(`paused: skip message wake ${poolId}`); return; }
    const r = this.d.queue.enqueue(makeWake("message", [poolId], `${db.reason}（合并${db.count}条）`, [], this.d.clock.now()));
    this.d.log?.(`message wake ${poolId} ${r}`);
  }

  private scheduleTick() {
    if (this.tickTimer) this.d.clock.clearTimeout(this.tickTimer);
    this.tickTimer = this.d.clock.setTimeout(() => { this.tick(); if (this.running) this.scheduleTick(); }, this.currentTickMs());
  }

  /** 一次 tick（公开以便测试/手动触发）。返回是否入队。 */
  tick(): boolean {
    if (this.d.isPaused()) return false;
    const now = this.d.clock.now();
    let enqueued = false;
    const fires = this.d.duePlans(now);
    if (fires.length) {
      this.d.queue.enqueue(makeWake("plan", [], `计划到点 #${fires.map((f) => f.planId).join(",#")}`, fires, now));
      enqueued = true;
    }
    // 正在去抖的池交给去抖处理，tick 不重复唤醒
    const pools = this.d.poolsWithUnread().filter((p) => !this.debounces.has(p));
    if (pools.length) {
      this.d.queue.enqueue(makeWake("tick", pools, "tick: 有未读", [], now));
      enqueued = true;
    }
    return enqueued;
  }
}
