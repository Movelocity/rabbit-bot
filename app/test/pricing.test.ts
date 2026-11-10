import { test } from "node:test";
import assert from "node:assert/strict";
import { costUsd, splitUsage } from "../src/core/pricing.ts";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

// 真实 session 样本（2026-11-10 15:33 北京时间，峰时）：
// {input:279, output:52, cacheRead:43008, cacheWrite:0, totalTokens:43339,
//  cost:{input:0.0000837, output:0.0000624, cacheRead:0.000258048, total:0.000404148}}
const realUsage = { input: 279, output: 52, cacheRead: 43008, cacheWrite: 0, totalTokens: 43339 };

test("splitUsage：input 是未命中、cacheRead 是命中，命中不被 input 截断", () => {
  const s = splitUsage(realUsage);
  assert.deepEqual(s, { hit: 43008, miss: 279, out: 52 });
  assert.equal(s.hit + s.miss + s.out, realUsage.totalTokens);
});

test("splitUsage：cacheWrite 并入 miss，三段之和等于 totalTokens", () => {
  const u = { input: 100, output: 10, cacheRead: 50, cacheWrite: 20, totalTokens: 180 };
  const s = splitUsage(u);
  assert.deepEqual(s, { hit: 50, miss: 120, out: 10 });
  assert.equal(s.hit + s.miss + s.out, u.totalTokens);
});

test("costUsd：峰时按官方单价算出的钱与 pi 报的 cost.total 一致", () => {
  const peak = Date.UTC(2026, 10, 10, 7, 0); // 周二 07:00 UTC = 北京 15:00，峰时
  close(costUsd("deepseek-flash", splitUsage(realUsage), peak), 0.000404148);
});

test("costUsd：谷时正好是峰时的一半", () => {
  const off = Date.UTC(2026, 10, 10, 12, 0); // 周二 12:00 UTC，谷时
  close(costUsd("deepseek-flash", splitUsage(realUsage), off), 0.000202074);
});
