/**
 * 单实例 FIFO 运行队列：同一时间只跑一个 Agent 实例；
 * 排队中（尚未开始）的同类唤醒合并为一个（池、计划触发、原因取并集），保持先到者的位置。
 */
import type { Wake, WakeType } from "../types.ts";

export type WakeHandler = (w: Wake) => Promise<void>;

export function makeWake(type: WakeType, pools: string[] = [], reason = "", planFires: Wake["planFires"] = [], now = Date.now()): Wake {
  return { type, pools: new Set(pools), planFires: [...planFires], reasons: reason ? [reason] : [], enqueuedAt: now };
}

export class RunQueue {
  private q: Wake[] = [];
  private running: Wake | null = null;
  private idleWaiters: (() => void)[] = [];
  private stopped = false;
  onError: (e: unknown, w: Wake) => void = (e) => console.error("[queue] handler error", e);

  constructor(private handler: WakeHandler) {}

  /** 返回 "merged" 或 "queued" */
  enqueue(w: Wake): "merged" | "queued" {
    const same = this.q.find((x) => x.type === w.type);
    if (same) {
      for (const p of w.pools) same.pools.add(p);
      for (const f of w.planFires) if (!same.planFires.some((g) => g.planId === f.planId && g.fireTs === f.fireTs)) same.planFires.push(f);
      for (const r of w.reasons) if (!same.reasons.includes(r)) same.reasons.push(r);
      return "merged";
    }
    this.q.push(w);
    queueMicrotask(() => this.pump());
    return "queued";
  }

  get pending(): readonly Wake[] { return this.q; }
  get current(): Wake | null { return this.running; }
  isBusy() { return this.running !== null || this.q.length > 0; }

  /** 等到队列空闲（测试/优雅退出用） */
  idle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
  stop() { this.stopped = true; this.q = []; }

  private async pump() {
    if (this.running || this.stopped) return;
    const next = this.q.shift();
    if (!next) {
      const ws = this.idleWaiters; this.idleWaiters = [];
      ws.forEach((r) => r());
      return;
    }
    this.running = next;
    try { await this.handler(next); } catch (e) { this.onError(e, next); }
    this.running = null;
    void this.pump();
  }
}
