import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { createTools } from "../src/agent/tools.ts";
import {
  DEFAULT_MEMORY_REVIEW_SETTINGS, effectiveMemoryReviewSettings, loadMemoryReviewState,
  memoryReviewDue, saveMemoryReviewSettings, saveMemoryReviewState, validateMemoryReviewSettings,
} from "../src/ops/memory-review.ts";

function setup() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-mem-review-"));
  const cfg = loadConfig({ runtimeDir });
  return { runtimeDir, cfg };
}

test("默认关闭；设置写在 runtime/memory-review.json", () => {
  const { runtimeDir, cfg } = setup();
  assert.equal(effectiveMemoryReviewSettings(cfg).enabled, false, "默认不偷偷跑");
  saveMemoryReviewSettings(cfg, { enabled: true, everyTurns: 5, minIntervalSec: 60 });
  assert.deepEqual(effectiveMemoryReviewSettings(cfg), { enabled: true, everyTurns: 5, minIntervalSec: 60 });
  assert.ok(fs.existsSync(path.join(runtimeDir, "memory-review.json")));
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

test("校验：回合数/间隔越界、类型不对都报清楚", () => {
  assert.throws(() => validateMemoryReviewSettings({ everyTurns: 0 }), /everyTurns/);
  assert.throws(() => validateMemoryReviewSettings({ everyTurns: 1001 }), /everyTurns/);
  assert.throws(() => validateMemoryReviewSettings({ minIntervalSec: 10 }), /minIntervalSec/);
  assert.throws(() => validateMemoryReviewSettings(null), /对象/);
  assert.deepEqual(validateMemoryReviewSettings({ enabled: true }), {
    ...DEFAULT_MEMORY_REVIEW_SETTINGS, enabled: true,
  });
});

test("状态：计数落盘，重启能读回", () => {
  const { runtimeDir, cfg } = setup();
  saveMemoryReviewState(cfg, { turns: 3, lastReviewAt: 123, lastOutcome: "ok" });
  assert.deepEqual(loadMemoryReviewState(cfg), { turns: 3, lastReviewAt: 123, lastOutcome: "ok" });
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});

test("到期判断：关着不跑，够数才跑，最小间隔拦住", () => {
  const on = { enabled: true, everyTurns: 10, minIntervalSec: 300 };
  const off = { ...on, enabled: false };
  const state = { turns: 0, lastReviewAt: 0, lastOutcome: "" };
  const now = 1_000_000;
  assert.equal(memoryReviewDue(off, { ...state, turns: 99 }, now), false, "总开关关着");
  assert.equal(memoryReviewDue(on, state, now), false, "还没到数量");
  assert.equal(memoryReviewDue(on, { ...state, turns: 10 }, now), true, "用户回合够了");
  assert.equal(memoryReviewDue(on, { ...state, turns: 10, lastReviewAt: now - 1000 }, now), false, "最小间隔还没过");
  assert.equal(memoryReviewDue(on, { ...state, turns: 10, lastReviewAt: now - 300_000 }, now), true, "间隔过了");
});

test("review 工具集只有 memory，没有发消息/建任务/建技能", () => {
  const { runtimeDir, cfg } = setup();
  const store = new Store(":memory:");
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(),
    profile: "review",
    primaryPool: () => null,
    currentUnread: () => [],
  }) as any[];
  assert.deepEqual(tools.map((t) => t.name), ["memory"]);
  store.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});
