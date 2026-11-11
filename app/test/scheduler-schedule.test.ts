/** 日程 tick：到点批量触发、写进共用池后只合一次唤醒；agent 忙完再等 1 分钟。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/core/clock.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import type { Schedule, Wake } from "../src/types.ts";

const base = {
  tickMs: 180_000, activeTickMs: 60_000, activeWindowMs: 600_000,
  debounceMs: 30_000, debounceMaxWaitMs: 120_000,
  scheduleTickMs: 10_000,
};

const SCHEDULE_POOL = "schedule:schedule";

function mkSchedule(id: number, nextAt: number): Schedule {
  return {
    id, title: `日程${id}`, content: `内容${id}`, kind: "delay",
    cron: null, delay_minutes: 1, next_at: nextAt, status: "active",
    last_fired_at: null, created_at: nextAt - 60_000, updated_at: nextAt - 60_000,
  };
}

function setup(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const due: Schedule[] = [];
  const fired: number[] = [];
  const wakes: Wake[] = [];
  const s = new Scheduler({ ...base, ...over } as any, {
    clock,
    queue: { enqueue: (w: Wake) => { wakes.push(w); return "queued" as const; } },
    isPaused: () => false,
    poolsWithUnread: () => [],
    dueSchedules: (now) => due.filter((x) => x.status === "active" && x.next_at <= now),
    fireSchedule: (x, now) => {
      fired.push(x.id);
      x.next_at = now + 86_400_000;
    },
    schedulePoolId: SCHEDULE_POOL,
    log: () => {},
    warn: () => {},
  });
  s.start();
  return { clock, due, fired, wakes, s };
}

test("同一轮到点的日程全部触发，只合成一次 schedule 唤醒", () => {
  const { clock, due, fired, wakes } = setup();
  due.push(mkSchedule(1, clock.now()), mkSchedule(2, clock.now()));

  clock.advance(10_000);
  assert.deepEqual(fired, [1, 2], "不再限制两条日程之间隔 1 分钟");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].type, "schedule");
  assert.deepEqual([...wakes[0].pools], [SCHEDULE_POOL]);
});

test("agent 在忙也照常触发，唤醒排进队列，不再等 1 分钟", () => {
  const { clock, due, fired, wakes } = setup();
  due.push(mkSchedule(1, clock.now()));

  clock.advance(10_000);
  assert.deepEqual(fired, [1]);
  assert.equal(wakes.length, 1);
});

test("没有到点日程时不触发也不唤醒", () => {
  const { clock, due, fired, wakes } = setup();
  due.push(mkSchedule(1, clock.now() + 3_600_000));
  clock.advance(300_000);
  assert.deepEqual(fired, []);
  assert.equal(wakes.length, 0);
});

