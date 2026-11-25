/** runner-tail：从执行器日志尾部还原最近活动，脱敏、截断、按轮次过滤。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRunnerDigest, formatRunnerDigest, redactText } from "../src/core/runner-tail.ts";

function fixture(lines: object[]): { root: string; file: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-runner-tail-"));
  const dir = path.join(root, "tasks", "7");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "runner.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return { root, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const task = {
  id: 7,
  executor: "opencode",
  session_id: "ses_abcdefghijklmnop",
  attempt: 2,
  runner_started_at: 1_000,
};

test("runner-tail：opencode 文本 + 工具调用，取最后活动并脱敏", () => {
  const now = 10_000;
  const fx = fixture([
    { type: "step_start", sessionID: "ses_abcdefghijklmnop", timestamp: 900 }, // 上一轮，应过滤
    { type: "tool_use", timestamp: 2_000, part: {
      type: "tool", tool: "bash",
      state: { status: "completed", input: { command: "mysql -upassword=hunter2 -psecretpass -e 'select 1'" }, output: "ok" },
    } },
    { type: "text", timestamp: 3_000, part: { type: "text", text: "正在核对只读准入" } },
    { type: "tool_use", timestamp: 4_000, part: {
      type: "tool", tool: "bash",
      state: {
        status: "completed",
        input: { command: "curl -H 'Authorization: Bearer sk_live_abcdefghijklmnop'" },
        output: "data:image/png;base64," + "A".repeat(300),
      },
    } },
    { type: "step_finish", timestamp: 4_500, part: { tokens: { total: 1 } } },
  ]);
  try {
    const d = readRunnerDigest(task, fx.root, { now, stuckMs: 5_000 });
    assert.equal(d.lastEventAt, 4_500);
    assert.equal(d.lastText, "正在核对只读准入");
    assert.equal(d.lastTool?.name, "bash");
    assert.match(d.lastTool?.input ?? "", /\*\*\*/);
    assert.equal((d.lastTool?.input ?? "").includes("sk_live_"), false);
    assert.equal((d.lastTool?.output ?? "").includes("base64,"), false);
    assert.equal(d.recent.length, 3);
    assert.match(d.recent[1].text, /正在核对只读准入/);
    assert.equal(d.silentMs, now - 4_500);
    assert.equal(d.stuck, true);
    const text = formatRunnerDigest(d);
    assert.match(text, /任务 #7 最近活动/);
    assert.match(text, /已静默/);
    assert.ok(text.length <= 1500);
  } finally {
    fx.cleanup();
  }
});

test("runner-tail：日志不存在时返回空摘要，不抛错", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-runner-missing-"));
  try {
    const d = readRunnerDigest(task, root, { now: 2_000 });
    assert.equal(d.lastEventAt, null);
    assert.equal(d.lastText, null);
    assert.equal(d.lastTool, null);
    assert.equal(d.recent.length, 0);
    assert.equal(d.stuck, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redactText：密钥、base64、URL token 都替换", () => {
  const out = redactText("password=abc token: xyz Authorization: Bearer qqq https://x/?access_token=zzz " + "A".repeat(220));
  assert.equal(out.includes("abc"), false);
  assert.equal(out.includes("xyz"), false);
  assert.equal(out.includes("qqq"), false);
  assert.equal(out.includes("zzz"), false);
  assert.match(out, /\*\*\*/);
  assert.match(out, /\[base64\]/);
});
