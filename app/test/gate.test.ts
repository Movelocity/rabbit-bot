import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGate, cooldownRequired, inQuietHours, gateCfg, GATE_DEFAULTS, type GateInput,
} from "../src/core/gate.ts";

const TZ = "Asia/Shanghai";
// 2026-11-03 15:00 北京时间（下午，不在静默段）
const T = new Date("2026-11-03T07:00:00.000Z").getTime();
const MIN = 60_000;

function base(over: Partial<GateInput> = {}): GateInput {
  return {
    now: T,
    urgency: 0.9,
    lastUserTs: T - 60 * MIN,      // 一小时前说过话
    poolLastUserTs: T - 60 * MIN,
    lastSpeakTs: 0,                 // 从没主动说过
    speaksToday: 0,
    consecutiveSpeaks: 0,
    chatStreaming: false,
    tz: TZ,
    ...over,
  };
}

test("全部门都过：返回 ok", () => {
  const v = evaluateGate(base());
  assert.equal(v.speak, true);
  assert.equal(v.reason, "ok");
});

test("从没聊过天不许主动：no_history", () => {
  const v = evaluateGate(base({ lastUserTs: 0, poolLastUserTs: 0 }));
  assert.equal(v.speak, false);
  assert.equal(v.reason, "no_history");
});

test("没有自省结果就不开口", () => {
  const v = evaluateGate(base({ urgency: null }));
  assert.equal(v.speak, false);
  assert.equal(v.reason, "no_reflection");
});

test("urgency 低于阈值被拦，等于阈值放行", () => {
  assert.equal(evaluateGate(base({ urgency: 0.34 })).reason, "low_urgency");
  assert.equal(evaluateGate(base({ urgency: 0.35 })).speak, true);
});

test("用户刚说完话不抢：not_silent", () => {
  const v = evaluateGate(base({ lastUserTs: T - 2 * MIN, poolLastUserTs: T - 2 * MIN }));
  assert.equal(v.speak, false);
  assert.equal(v.reason, "not_silent");
});

test("沉默时长取「全局」和「本池」里更近的那条", () => {
  // 别的池刚说过话，本池一小时没动静 → 用户其实还在，不能主动
  const v = evaluateGate(base({ lastUserTs: T - 2 * MIN, poolLastUserTs: T - 60 * MIN }));
  assert.equal(v.reason, "not_silent");
});

test("夜间静默：凌晨两点不许叫", () => {
  const night = new Date("2026-11-03T18:00:00.000Z").getTime(); // 北京 02:00
  const v = evaluateGate(base({ now: night, lastUserTs: night - 60 * MIN, poolLastUserTs: night - 60 * MIN }));
  assert.equal(v.speak, false);
  assert.equal(v.reason, "quiet_hours");
});

test("静默段跨零点也认", () => {
  const cfg = gateCfg();
  const at = (iso: string) => inQuietHours(new Date(iso).getTime(), cfg, TZ);
  assert.equal(at("2026-11-03T15:45:00.000Z"), true);  // 23:45
  assert.equal(at("2026-11-03T18:30:00.000Z"), true);  // 02:30
  assert.equal(at("2026-11-04T00:10:00.000Z"), false); // 08:10
  assert.equal(at("2026-11-03T07:00:00.000Z"), false); // 15:00
});

test("冷却按 urgency 缩放：越想说话等得越短", () => {
  const lo = cooldownRequired(GATE_DEFAULTS.urgencyThreshold, GATE_DEFAULTS.minIntervalMs);
  const hi = cooldownRequired(1, GATE_DEFAULTS.minIntervalMs);
  assert.ok(hi < lo, `urgency 高应该等更短：hi=${hi} lo=${lo}`);
  assert.equal(hi, Math.round(GATE_DEFAULTS.minIntervalMs * 0.15));
  assert.equal(lo, Math.round(GATE_DEFAULTS.minIntervalMs * (1 - 0.35 * 0.85)));
});

test("冷却没过被拦，过了放行", () => {
  const cd = cooldownRequired(0.9, GATE_DEFAULTS.minIntervalMs);
  assert.equal(evaluateGate(base({ lastSpeakTs: T - cd + MIN })).reason, "cooldown");
  assert.equal(evaluateGate(base({ lastSpeakTs: T - cd - MIN })).speak, true);
});

test("24 小时上限", () => {
  const v = evaluateGate(base({ speaksToday: GATE_DEFAULTS.maxPerDay }));
  assert.equal(v.reason, "daily_limit");
  assert.equal(evaluateGate(base({ speaksToday: GATE_DEFAULTS.maxPerDay - 1 })).speak, true);
});

test("连说没人回就闭嘴", () => {
  const v = evaluateGate(base({ consecutiveSpeaks: 3 }));
  assert.equal(v.speak, false);
  assert.equal(v.reason, "no_response");
});

test("正在生成回复时不插话", () => {
  assert.equal(evaluateGate(base({ chatStreaming: true })).reason, "chat_streaming");
});

test("门是按顺序短路的：先报便宜的理由", () => {
  // 既低 urgency 又深夜又冷却中，应该报 low_urgency
  const night = new Date("2026-11-03T18:00:00.000Z").getTime();
  const v = evaluateGate(base({
    now: night, urgency: 0.1, lastUserTs: night - 60 * MIN, poolLastUserTs: night - 60 * MIN,
    lastSpeakTs: night - MIN, speaksToday: 99, consecutiveSpeaks: 9,
  }));
  assert.equal(v.reason, "low_urgency");
});

test("配置可以覆盖默认值", () => {
  const v = evaluateGate(base({ urgency: 0.5, cfg: { urgencyThreshold: 0.6 } }));
  assert.equal(v.reason, "low_urgency");
});
