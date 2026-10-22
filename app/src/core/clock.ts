/** 可注入的时钟，便于测试调度/去抖。 */
export interface Clock {
  /** 墙上时间（ms） */
  now(): number;
  /** 单调时间（ms）。定时器按它走；VM/进程被冻结时它不前进而墙上时间会跳，可据此发现暂停 */
  mono?(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** 测试用手动时钟 */
export class FakeClock implements Clock {
  private t: number;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  constructor(start = Date.UTC(2026, 9, 22, 1, 0, 0)) { this.t = start; }
  private paused = 0;
  now() { return this.t; }
  mono() { return this.t - this.paused; }
  /** 模拟 VM/进程冻结 ms：墙上时间前进，但单调时钟与所有定时器都被一起推迟（不触发） */
  freeze(ms: number) {
    this.t += ms;
    this.paused += ms;
    for (const e of this.timers.values()) e.at += ms;
  }
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
