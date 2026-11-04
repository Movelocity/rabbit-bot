/**
 * 主动唤醒的冷却锚点：用「上次尝试」而不是「上次真发」。
 *
 * 线上实测过的坑：她 09:44–10:42 被同一个念头连醒 19 次，只发出 2 条。
 * 原因是她忍住不说的那些轮次在库里只留了 agent_silent 的 skip，
 * 而冷却只看 decision='speak'，于是每 tick 六道门全开，反复唤醒、反复烧调用。
 *
 * 这条测试锁两件事：agent_silent 算尝试；被门拦下的 skip（reason 不是 agent_silent）不算。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";

const base = { user_id: "u1", pool_id: "p1", urgency: 0.4, silent_sec: 600, cooldown_req: null };

test("proactive：agent_silent 的 skip 算一次尝试，冷却按它起算", () => {
  const s = new Store(":memory:");
  s.logProactive({ ...base, ts: 1_000, decision: "skip", reason: "cooldown" });        // 被门拦下：不算尝试
  s.logProactive({ ...base, ts: 2_000, decision: "skip", reason: "agent_silent:no-reason" }); // 醒了但没说：算
  assert.equal(s.lastProactiveSpeakTs("p1"), 0, "一次都没发出去");
  assert.equal(s.lastProactiveAttemptTs("p1"), 2_000);
  s.close();
});

test("proactive：真发出去的 speak 之后，尝试时刻跟着走", () => {
  const s = new Store(":memory:");
  s.logProactive({ ...base, ts: 5_000, decision: "skip", reason: "agent_silent:too-late" });
  s.logProactive({ ...base, ts: 9_000, decision: "speak", reason: "ok" });
  assert.equal(s.lastProactiveAttemptTs("p1"), 9_000);
  assert.equal(s.lastProactiveSpeakTs("p1"), 9_000);
  s.close();
});

test("proactive：被门拦下的 skip 不会把冷却时钟越推越远", () => {
  const s = new Store(":memory:");
  s.logProactive({ ...base, ts: 1_000, decision: "skip", reason: "low_urgency" });
  s.logProactive({ ...base, ts: 3_000, decision: "skip", reason: "cooldown" });
  s.logProactive({ ...base, ts: 7_000, decision: "skip", reason: "quiet_hours" });
  assert.equal(
    s.lastProactiveAttemptTs("p1"), 0,
    "这些是「没被唤醒」，当成尝试的话冷却会以自己为锚不断刷新，她永远开不了口",
  );
  s.close();
});
