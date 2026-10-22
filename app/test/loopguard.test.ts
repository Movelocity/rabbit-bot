import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuardCore, applyCommunityLoopGuardEnv, builtinLoopGuardExtension, callKey, communityLoopGuardPath, resultFp } from "../src/core/loopguard.ts";

const cfg = { warnThreshold: 5, blockThreshold: 10, abortAfterBlocks: 1 };

test("内置：连续 10 次一模一样（工具+参数+结果）→ 第 10 次拦截并结束本轮", () => {
  const g = new LoopGuardCore(cfg);
  const k = callKey("read_pool", { pool: "p1", limit: 1 });
  const fp = resultFp([{ type: "text", text: "same" }]);
  let warns = 0;
  for (let i = 1; i <= 9; i++) {
    assert.deepEqual(g.check(k), { block: false, abort: false }, `第 ${i} 次应放行`);
    if (g.record(k, fp).warn) warns++;
  }
  assert.deepEqual(g.check(k), { block: true, abort: true });
  assert.equal(warns, 1);
});

test("参数顺序无关；结果变化（轮询）不算循环；换参数重置", () => {
  assert.equal(callKey("t", { a: 1, b: { c: 2, d: 3 } }), callKey("t", { b: { d: 3, c: 2 }, a: 1 }));
  const g = new LoopGuardCore(cfg);
  const k = callKey("send", { pool: "p1", content: "hi" });
  for (let i = 0; i < 30; i++) { assert.equal(g.check(k).block, false); g.record(k, resultFp([{ type: "text", text: `r${i}` }])); }
  const g2 = new LoopGuardCore(cfg);
  for (let i = 0; i < 30; i++) {
    const kk = callKey("t", { i: i % 2 });
    assert.equal(g2.check(kk).block, false);
    g2.record(kk, "x");
  }
});

test("reset 后重新计数", () => {
  const g = new LoopGuardCore(cfg);
  const k = callKey("t", {});
  for (let i = 0; i < 9; i++) g.record(k, "x");
  g.reset();
  assert.equal(g.check(k).block, false);
});

/** 用一个最小的 mock ExtensionAPI 驱动扩展 */
async function drive(factory: (pi: any) => void, n: number) {
  const handlers = new Map<string, Function>();
  let aborted = 0, warned = 0;
  factory({ on: (ev: string, fn: Function) => handlers.set(ev, fn), sendMessage: () => { warned++; } });
  const ctx = { abort: () => { aborted++; }, cwd: "/", isIdle: () => false };
  handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: "", systemPrompt: "" }, ctx);
  let blockedAt = -1;
  for (let i = 1; i <= n; i++) {
    const call = { type: "tool_call", toolCallId: `c${i}`, toolName: "read_pool", input: { pool: "p1" } };
    const r = handlers.get("tool_call")!(call, ctx);
    if (r?.block) { blockedAt = i; break; }
    handlers.get("tool_result")!({ ...call, type: "tool_result", content: [{ type: "text", text: "same" }], isError: false }, ctx);
  }
  return { blockedAt, aborted, warned };
}

test("内置扩展（pi 扩展接口）：第 10 次拦截 + abort", async () => {
  const r = await drive(builtinLoopGuardExtension(cfg), 20);
  assert.deepEqual(r, { blockedAt: 10, aborted: 1, warned: 1 });
});

test("社区扩展 pi-death-loop-guard 按配置：第 10 次拦截 + abort", async () => {
  const p = communityLoopGuardPath();
  assert.ok(p, "应已安装 pi-death-loop-guard");
  applyCommunityLoopGuardEnv(cfg);
  const mod = await import(p!);
  const r = await drive(mod.default, 20);
  assert.deepEqual(r, { blockedAt: 10, aborted: 1, warned: 1 });
});
