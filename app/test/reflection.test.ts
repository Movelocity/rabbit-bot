import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReflection, extractJsonObject, buildReflectionPrompt, EMPTY_REFLECTION,
  MIN_NEXT_SEC, MAX_NEXT_SEC,
} from "../src/core/reflection.ts";

test("干净 JSON 直接解析", () => {
  const r = parseReflection(JSON.stringify({
    thought: "他今天说了三次加班", style_hint: "随口问一句", urgency: 0.72,
    topic_pick: "加班", topic_angle: "问累不累，别说教", next_reflection_in: 1800,
  }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.urgency, 0.72);
  assert.equal(r.value.thought, "他今天说了三次加班");
  assert.equal(r.value.nextReflectionInSec, 1800);
});

test("代码围栏和前后废话都能容忍", () => {
  const r = parseReflection('我想了想：\n```json\n{"urgency":0.4,"thought":"还行"}\n```\n大概就这样。');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.urgency, 0.4);
});

test("thought 里带花括号也不会截断", () => {
  const r = parseReflection('{"urgency":0.5,"thought":"她想说 {这个} 和 } 那个"}');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.thought, "她想说 {这个} 和 } 那个");
});

test("urgency 是字符串也收，越界夹到 [0,1]", () => {
  assert.equal((parseReflection('{"urgency":"0.8"}') as any).value.urgency, 0.8);
  assert.equal((parseReflection('{"urgency":1.9}') as any).value.urgency, 1);
  assert.equal((parseReflection('{"urgency":-3}') as any).value.urgency, 0);
});

test("缺 urgency 算失败——没分就没法门控", () => {
  const r = parseReflection('{"thought":"随便想想"}');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "missing-urgency");
});

test("完全不是 JSON 也算失败，但不会抛错", () => {
  const r = parseReflection("（沉默）");
  assert.equal(r.ok, false);
});

test("坏 JSON 报 bad-json", () => {
  const r = parseReflection('{"urgency":0.5,}');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, "bad-json");
});

test("next_reflection_in 被夹进 300..10800", () => {
  assert.equal((parseReflection('{"urgency":0.5,"next_reflection_in":10}') as any).value.nextReflectionInSec, MIN_NEXT_SEC);
  assert.equal((parseReflection('{"urgency":0.5,"next_reflection_in":99999}') as any).value.nextReflectionInSec, MAX_NEXT_SEC);
  assert.equal((parseReflection('{"urgency":0.5}') as any).value.nextReflectionInSec, null);
});

test("extractJsonObject 找不到对象返回 null", () => {
  assert.equal(extractJsonObject("没有花括号"), null);
  assert.equal(extractJsonObject('{"a":1} 后面还有 {"b":2}'), '{"a":1}');
});

test("提示词包含 urgency 锚点，且明确允许不想说话", () => {
  const p = buildReflectionPrompt({
    now: new Date("2026-11-03T07:00:00Z").getTime(), tz: "Asia/Shanghai",
    agentName: "大肥鱼",
    recentLines: ["[15:00] 对方：今天加班到九点", "[15:01] 大肥鱼：又加"],
    silentMinutes: 42,
    lastProactive: null,
    prevThought: "他最近好像很累",
    consecutiveSpeaks: 0,
  });
  assert.match(p, /0\.9–1\.0/);
  assert.match(p, /低于 0\.3/);      // 允许她给低分，不然都会给 0.5
  assert.match(p, /next_reflection_in/);
  assert.match(p, /42 分钟/);
  assert.match(p, /他最近好像很累/);  // 想事情的连续性
});

test("连说没人回时提示词会点出来", () => {
  const p = buildReflectionPrompt({
    now: Date.now(), tz: "Asia/Shanghai", agentName: "大肥鱼", recentLines: [],
    silentMinutes: 300, lastProactive: { text: "在吗", replied: false },
    prevThought: null, consecutiveSpeaks: 2,
  });
  assert.match(p, /连着主动说了 2 次/);
  assert.match(p, /对方没回/);
});

test("EMPTY_REFLECTION 是合法的「没什么想说」", () => {
  assert.equal(EMPTY_REFLECTION.urgency, 0);
  assert.ok(EMPTY_REFLECTION.urgency < 0.35);
});
