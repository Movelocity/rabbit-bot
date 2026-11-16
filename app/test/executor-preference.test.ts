/** 默认 worker 偏好：保存到 data/run/executor.json，重启后能读回；坏值回退 opencode。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  effectiveExecutorPreference, loadExecutorPreference, saveExecutorPreference,
} from "../src/ops/executor-preference.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-executor-preference-"));
  const cfg = loadConfig({ dataDir: dir });
  return { dir, cfg, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("没有文件时默认 opencode", () => {
  const x = fixture();
  try {
    assert.equal(effectiveExecutorPreference(x.cfg), "opencode");
    assert.equal(loadExecutorPreference(x.cfg), "opencode");
  } finally { x.cleanup(); }
});

test("保存 codex 后重启能读回", () => {
  const x = fixture();
  try {
    assert.equal(saveExecutorPreference(x.cfg, "codex"), "codex");
    const file = path.join(x.dir, "run", "executor.json");
    assert.equal(fs.existsSync(file), true);

    const restarted = loadConfig({ dataDir: x.dir });
    assert.equal(loadExecutorPreference(restarted), "codex");
    assert.equal(effectiveExecutorPreference(restarted), "codex");
  } finally { x.cleanup(); }
});

test("保存 claude 后重启能读回", () => {
  const x = fixture();
  try {
    assert.equal(saveExecutorPreference(x.cfg, "claude"), "claude");
    const restarted = loadConfig({ dataDir: x.dir });
    assert.equal(loadExecutorPreference(restarted), "claude");
    assert.equal(effectiveExecutorPreference(restarted), "claude");
  } finally { x.cleanup(); }
});

test("坏值 / 坏文件回退 opencode，不抛异常", () => {
  const x = fixture();
  try {
    const file = path.join(x.dir, "run", "executor.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ executor: "other" }), "utf8");
    assert.equal(loadExecutorPreference(x.cfg), "opencode");
    fs.writeFileSync(file, "not json", "utf8");
    assert.equal(loadExecutorPreference(x.cfg), "opencode");
  } finally { x.cleanup(); }
});
