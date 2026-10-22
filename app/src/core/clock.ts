/** 可注入的时钟，便于测试调度/去抖。 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** 测试用手动时钟 */
export class FakeClock implements Clock {
  private t: number;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  constructor(start = Date.UTC(2026, 9, 22, 1, 0, 0)) { this.t = start; }
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: unknown) { this.timers.delete(h as number); }
  /** 推进时间并按顺序触发到期定时器 */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let best: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= target && (!best || e[1].at < best[1].at)) best = e;
      if (!best) break;
      this.timers.delete(best[0]);
      this.t = best[1].at;
      best[1].fn();
    }
    this.t = target;
  }
  pending() { return this.timers.size; }
}
