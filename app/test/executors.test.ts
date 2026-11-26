/** 执行器探测：能识别 PATH / MIMO_BIN / CODEX_BIN / CLAUDE_BIN 里的 CLI，并且不会因为缺失就抛错。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listExecutorsAsync, resetExecutorProbeCache } from "../src/ops/executors.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-executors-"));

function fake(name: string, version: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return file;
}

test("探测本机 opencode / mimo / codex / claude 的可用性和版本", async () => {
  const opencode = fake("opencode", "9.9.9-opencode");
  const mimo = fake("mimo", "9.9.9-mimo");
  const codex = fake("codex", "9.9.9-codex");
  const claude = fake("claude", "9.9.9-claude");
  const oldPath = process.env.PATH;
  const oldMimo = process.env.MIMO_BIN;
  const oldCodex = process.env.CODEX_BIN;
  const oldClaude = process.env.CLAUDE_BIN;
  process.env.PATH = `${dir}:${oldPath ?? "/usr/bin:/bin"}`;
  process.env.MIMO_BIN = mimo;
  process.env.CODEX_BIN = codex;
  process.env.CLAUDE_BIN = claude;
  resetExecutorProbeCache();
  try {
    const list = await listExecutorsAsync();
    assert.deepEqual(list.map((e) => e.name), ["opencode", "mimo", "codex", "claude"]);
    for (const e of list) {
      assert.equal(e.available, true, `${e.name} 应可用`);
      assert.equal(e.version, `9.9.9-${e.name}`);
      assert.equal(e.error, "");
    }
    assert.equal(list[0].bin, opencode);
    assert.equal(list[1].bin, mimo);
    assert.equal(list[2].bin, codex);
    assert.equal(list[3].bin, claude);
  } finally {
    process.env.PATH = oldPath;
    process.env.MIMO_BIN = oldMimo;
    process.env.CODEX_BIN = oldCodex;
    process.env.CLAUDE_BIN = oldClaude;
  }
});

test("CLAUDE_BIN 未设置时按 PATH 探测全局 claude", async () => {
  const claude = fake("claude-path", "9.9.9-path-claude");
  const binDir = path.join(dir, "claude-path-bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.renameSync(claude, path.join(binDir, "claude"));
  const oldPath = process.env.PATH;
  const oldClaude = process.env.CLAUDE_BIN;
  process.env.PATH = `${binDir}:${oldPath ?? "/usr/bin:/bin"}`;
  delete process.env.CLAUDE_BIN;
  resetExecutorProbeCache();
  try {
    const entry = (await listExecutorsAsync()).find((e) => e.name === "claude")!;
    assert.equal(entry.available, true);
    assert.equal(entry.bin, path.join(binDir, "claude"));
    assert.equal(entry.version, "9.9.9-path-claude");
  } finally {
    process.env.PATH = oldPath;
    if (oldClaude === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = oldClaude;
  }
});

test("没装的 CLI 返回 available=false，不抛异常", async () => {
  const missingMimo = path.join(dir, "nope-mimo");
  const missingCodex = path.join(dir, "nope-codex");
  const missingClaude = path.join(dir, "nope-claude");
  const oldPath = process.env.PATH;
  const oldMimo = process.env.MIMO_BIN;
  const oldCodex = process.env.CODEX_BIN;
  const oldClaude = process.env.CLAUDE_BIN;
  process.env.PATH = "/usr/bin:/bin";
  process.env.MIMO_BIN = missingMimo;
  process.env.CODEX_BIN = missingCodex;
  process.env.CLAUDE_BIN = missingClaude;
  resetExecutorProbeCache();
  try {
    const list = await listExecutorsAsync();
    const mimo = list.find((e) => e.name === "mimo")!;
    assert.equal(mimo.available, false);
    assert.equal(mimo.bin, missingMimo);
    assert.ok(mimo.error);
    const codex = list.find((e) => e.name === "codex")!;
    assert.equal(codex.available, false);
    assert.equal(codex.bin, missingCodex);
    assert.ok(codex.error);
    const claude = list.find((e) => e.name === "claude")!;
    assert.equal(claude.available, false);
    assert.equal(claude.bin, missingClaude);
    assert.ok(claude.error);
  } finally {
    process.env.PATH = oldPath;
    process.env.MIMO_BIN = oldMimo;
    process.env.CODEX_BIN = oldCodex;
    process.env.CLAUDE_BIN = oldClaude;
  }
});
