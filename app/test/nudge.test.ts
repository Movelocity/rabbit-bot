import { test } from "node:test";
import assert from "node:assert/strict";
import { needsPlanNudge } from "../src/core/nudge.ts";

const send = { name: "send" };
const planAdd = { name: "plan_add" };

test("计划唤醒：说了话但没排下次 → 要补提醒", () => {
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [send] }), true);
});

test("计划唤醒：说完了也排了 → 不补", () => {
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [send, planAdd] }), false);
});

test("计划唤醒：一个字没说 → 不补（沉默是合法的）", () => {
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [] }), false);
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [{ name: "plan_list" }] }), false);
});

test("回消息的唤醒不归它管 → 不补", () => {
  assert.equal(needsPlanNudge({ wakeType: "message", toolCalls: [send] }), false);
  assert.equal(needsPlanNudge({ wakeType: "tick", toolCalls: [send] }), false);
});

test("出错或中断 → 不补", () => {
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [send], error: "boom" }), false);
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [send], aborted: true }), false);
});

test("send 失败不算说过话", () => {
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [{ name: "send", isError: true }] }), false);
});

test("plan_add 失败不算排上了", () => {
  assert.equal(needsPlanNudge({ wakeType: "plan", toolCalls: [send, { name: "plan_add", isError: true }] }), true);
});
