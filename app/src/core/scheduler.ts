/**
 * 调度器（纯代码）：
 * - tick：默认 3 分钟；活跃对话期间缩短为 activeTickMs，静默 activeWindowMs 后回到默认。
 *   tick 时有未读才唤醒（不调用 LLM 做判断），并检查计划时间表。
 * - 私聊新消息 / 群里被 @：进入去抖；最后一条后静默 debounceMs（且最长 debounceMaxWaitMs）再入队，不插队。
 * - 群里未被 @ 的消息：只在 tick 时被读到。
 * - 看门狗（watchdogMs>0）：按墙上时间检查去抖/tick 是否逾期未触发（定时器丢失、事件循环卡住、VM 被冻结后恢复），
 *   逾期就立即补触发；并比较墙上时间与单调时间，发现暂停/时钟跳变时记日志。
 * 调度与收发长连接完全无关：连接断开时照样唤醒、照样经 HTTP 发送。
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
  /** 水位退潮到档的池（tick 用）：没有未读也可能因为这些池唤醒 agent 自己找话题 */
  proactivePools?: (now: number) => NonNullable<Wake["proactive"]>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}
export interface SchedulerConfig {
  tickMs: number; activeTickMs: number; activeWindowMs: number; debounceMs: number; debounceMaxWaitMs: number;
  /** 看门狗间隔，0/缺省 = 关闭 */
  watchdogMs?: number;
  /** 逾期多少毫秒算“丢了”，默认 2000 */
  overdueGraceMs?: number;
  /**
   * 合并窗：一次唤醒结束后，这段时间内到这个池的消息先攒着，窗口关时合并成一次唤醒。
   * 0/缺省 = 关闭（每条消息各叫一次）。窗口管的是「同一个 session 内不反复叫醒」，
   * 不管 tick、不管群里未被 @ 的消息。
   */
  sessionWindowMs?: number;
}

interface Debounce { timer: unknown; firstAt: number; dueAt: number; count: number; reason: string }
/** 唤醒后的静默窗：窗内来的消息攒在 pending 里，窗口关时一起叫一次 */
interface SessionWindow { timer: unknown; until: number; pending: number; reason: string }

export interface SchedulerStats { lastTickAt: number | null; nextTickAt: number | null; debouncing: { pool: string; dueAt: number; count: number }[]; recovered: number; pausesDetected: number }

export class Scheduler {
  private debounces = new Map<string, Debounce>();
  private windows = new Map<string, SessionWindow>();
  private tickTimer: unknown = null;
  private tickDueAt: number | null = null;
  private lastTickAt: number | null = null;
  private lastActivity = -Infinity;
  private running = false;
  private wdTimer: unknown = null;
  private wdLast: { wall: number; mono: number } | null = null;
  private recovered = 0;
  private pausesDetected = 0;
  constructor(private cfg: SchedulerConfig, private d: SchedulerDeps) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.scheduleTick();
    if (this.cfg.watchdogMs && this.cfg.watchdogMs > 0) this.scheduleWatchdog();
  }
  stop() {
    this.running = false;
    if (this.tickTimer) this.d.clock.clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.tickDueAt = null;
    if (this.wdTimer) this.d.clock.clearTimeout(this.wdTimer);
    this.wdTimer = null;
    for (const db of this.debounces.values()) this.d.clock.clearTimeout(db.timer);
    this.debounces.clear();
    for (const w of this.windows.values()) this.d.clock.clearTimeout(w.timer);
    this.windows.clear();
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
    // 刚说过话的 300 秒内：这段对话还在同一个 session 里，攒到窗口关再一起叫一次，
    // 不然他连发十条就是十次完整唤醒，每条都重新付一遍 system+工具 schema 的底价。
    const win = this.windows.get(poolId);
    if (win && now < win.until) {
      win.pending += 1;
      if (!win.reason) win.reason = reason;
      return;
    }
    const prev = this.debounces.get(poolId);
    if (prev) this.d.clock.clearTimeout(prev.timer);
    const firstAt = prev?.firstAt ?? now;
    const remainingMax = firstAt + this.cfg.debounceMaxWaitMs - now;
    const delay = Math.max(0, Math.min(this.cfg.debounceMs, remainingMax));
    const db: Debounce = { timer: null, firstAt, dueAt: now + delay, count: (prev?.count ?? 0) + 1, reason: prev?.reason ?? reason };
    db.timer = this.d.clock.setTimeout(() => { if (this.debounces.get(poolId) === db) this.fireDebounce(poolId, "timer"); }, delay);
    this.debounces.set(poolId, db);
  }
  isDebouncing(poolId: string) { return this.debounces.has(poolId); }

  /**
   * 一次唤醒结束了：给这些池开合并窗。
   * 只有 message 唤醒该开——她是刚回过话，接下来五分钟算同一段对话；
   * tick/计划唤醒不拦消息，否则她自言自语一次就把人晾五分钟。
   */
  onWakeDone(poolIds: Iterable<string>) {
    const ms = this.cfg.sessionWindowMs ?? 0;
    if (ms <= 0) return;
    const now = this.d.clock.now();
    for (const poolId of poolIds) {
      const prev = this.windows.get(poolId);
      if (prev) this.d.clock.clearTimeout(prev.timer);
      const w: SessionWindow = { timer: null, until: now + ms, pending: 0, reason: "" };
      w.timer = this.d.clock.setTimeout(() => this.closeWindow(poolId, w), ms);
      this.windows.set(poolId, w);
    }
  }

  /** 窗口关了：攒了消息就叫一次，没攒就不叫（他自己不说话，不该白烧一笔） */
  private closeWindow(poolId: string, w: SessionWindow) {
    if (this.windows.get(poolId) !== w) return;
    this.windows.delete(poolId);
    if (!w.pending) return;
    try {
      if (this.d.isPaused()) { this.d.log?.(`paused: skip merged wake ${poolId}`); return; }
      const r = this.d.queue.enqueue(makeWake("message", [poolId], `${w.reason || "新消息"}（合并${w.pending}条·窗口）`, [], this.d.clock.now()));
      this.d.log?.(`message wake ${poolId} ${r}（合并窗关闭，${w.pending} 条）`);
    } catch (e) {
      this.d.warn?.(`合并窗入队失败：${(e as Error).message}`);
    }
  }

  /** 测试/观测用：这个池现在是否在合并窗里 */
  inSessionWindow(poolId: string): boolean {
    const w = this.windows.get(poolId);
    return !!w && this.d.clock.now() < w.until;
  }

  private fireDebounce(poolId: string, via: "timer" | "watchdog") {
    const db = this.debounces.get(poolId);
    this.debounces.delete(poolId);
    if (!db) return;
    this.d.clock.clearTimeout(db.timer);
    try {
      if (this.d.isPaused()) { this.d.log?.(`paused: skip message wake ${poolId}`); return; }
      const now = this.d.clock.now();
      const r = this.d.queue.enqueue(makeWake("message", [poolId], `${db.reason}（合并${db.count}条）`, [], now));
      const late = now - db.dueAt;
      this.d.log?.(`message wake ${poolId} ${r}${via === "watchdog" || late > (this.cfg.overdueGraceMs ?? 2000) ? `（看门狗补触发，迟到 ${Math.round(late / 1000)}s）` : ""}`);
    } catch (e) {
      this.d.warn?.(`message wake ${poolId} 入队失败：${(e as Error).message}（下次 tick 兜底）`);
    }
  }

  private scheduleTick() {
    if (this.tickTimer) this.d.clock.clearTimeout(this.tickTimer);
    const ms = this.currentTickMs();
    this.tickDueAt = this.d.clock.now() + ms;
    const handle = this.d.clock.setTimeout(() => { if (this.tickTimer === handle) this.runTick("timer"); }, ms);
    this.tickTimer = handle;
  }
  /** 定时 tick：无论 tick 本身是否出错，都保证排下一次 */
  private runTick(via: "timer" | "watchdog") {
    this.tickTimer = null;
    try {
      if (via === "watchdog") this.d.log?.(`tick 逾期 ${Math.round((this.d.clock.now() - (this.tickDueAt ?? 0)) / 1000)}s，看门狗补触发`);
      this.tick();
    } catch (e) {
      this.d.warn?.(`tick 出错：${(e as Error).message}`);
    } finally {
      if (this.running) this.scheduleTick();
    }
  }

  /** 一次 tick（公开以便测试/手动触发）。返回是否入队。 */
  tick(): boolean {
    this.lastTickAt = this.d.clock.now();
    if (this.d.isPaused()) return false;
    const now = this.d.clock.now();
    let enqueued = false;
    const fires = this.d.duePlans(now);
    if (fires.length) {
      this.d.queue.enqueue(makeWake("plan", [], `计划到点 #${fires.map((f) => f.planId).join(",#")}`, fires, now));
      enqueued = true;
    }
    // 水位退潮到档：即使没有未读也要给 agent 一次「要不要自己开口」的机会
    const pro = this.d.proactivePools?.(now) ?? [];
    if (pro.length) {
      const proPools = pro.map((x) => x.pool).filter((x): x is string => !!x);
      this.d.queue.enqueue(makeWake("tick", proPools, `水位到档：${pro.map((x) => x.detail).join("；")}`, [], now, pro));
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

  // ---------- 看门狗 ----------
  private scheduleWatchdog() {
    this.wdTimer = this.d.clock.setTimeout(() => {
      try { this.watchdog(); } catch (e) { this.d.warn?.(`看门狗出错：${(e as Error).message}`); }
      if (this.running) this.scheduleWatchdog();
    }, this.cfg.watchdogMs!);
  }
  /** 公开以便测试 */
  watchdog() {
    const c = this.d.clock;
    const wall = c.now();
    const mono = c.mono ? c.mono() : wall;
    if (this.wdLast) {
      const gap = (wall - this.wdLast.wall) - (mono - this.wdLast.mono);
      if (Math.abs(gap) > 2000) {
        this.pausesDetected++;
        this.d.warn?.(`检测到时钟跳变/进程被冻结：墙上时间比单调时间多走了 ${Math.round(gap / 1000)}s（VM 暂停或系统对时），检查逾期定时器`);
      }
    }
    this.wdLast = { wall, mono };
    const grace = this.cfg.overdueGraceMs ?? 2000;
    // 先补 tick（它会跳过仍在去抖的池），再补去抖，避免同一池被唤醒两次
    if (this.running && this.tickDueAt !== null && wall - this.tickDueAt > grace) {
      this.recovered++;
      if (this.tickTimer) c.clearTimeout(this.tickTimer);
      this.runTick("watchdog");
    }
    for (const [pool, db] of [...this.debounces]) {
      if (wall - db.dueAt > grace) { this.recovered++; this.fireDebounce(pool, "watchdog"); }
    }
  }

  stats(): SchedulerStats {
    return {
      lastTickAt: this.lastTickAt, nextTickAt: this.tickDueAt,
      debouncing: [...this.debounces].map(([pool, d]) => ({ pool, dueAt: d.dueAt, count: d.count })),
      recovered: this.recovered, pausesDetected: this.pausesDetected,
    };
  }
}
