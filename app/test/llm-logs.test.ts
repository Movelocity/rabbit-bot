/** 模型实际日志：按会话读 session JSONL，摘要 + 分页详情。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { listLlmSessions, readLlmSession } from "../src/ops/llm-logs.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-llm-logs-"));
const sessions = path.join(dir, "sessions");
fs.mkdirSync(sessions, { recursive: true });
const cfg = { ...loadConfig(), dataDir: dir };

const lines = (entries: unknown[]) => entries.map((x) => JSON.stringify(x)).join("\n") + "\n";

function writeSession(id: string, extra: unknown[] = []) {
  fs.writeFileSync(path.join(sessions, `${id}.jsonl`), lines([
    { type: "session", timestamp: "2026-11-12T07:00:00.000Z", id },
    { type: "model_change", provider: "deepseek", modelId: "deepseek-flash" },
    { type: "message", timestamp: "2026-11-12T07:00:01.000Z", message: { role: "system", content: "系统提示" } },
    { type: "message", timestamp: "2026-11-12T07:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "【这一轮：message】\n唤醒原因：私聊新消息（合并1条）\n\n近期上下文 [p1 feishu私聊「A」]：\n帮我看一下" }] } },
    { type: "message", timestamp: "2026-11-12T07:00:03.000Z", message: {
      role: "assistant", provider: "deepseek", model: "deepseek-flash",
      content: [{ type: "text", text: "好" }, { type: "toolCall", id: "c1", name: "chat", arguments: { action: "send" } }],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 0, totalTokens: 6, cost: { total: 0.001 } },
      stopReason: "stop", durationMs: 12,
    } },
    { type: "message", timestamp: "2026-11-12T07:00:04.000Z", message: {
      role: "toolResult", toolName: "chat", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false,
    } },
    ...extra,
  ]));
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("list：摘要带模型、消息数、预览和池", () => {
  writeSession("2026-11-12T07-00-00-000Z_aaa");
  const rows = listLlmSessions(cfg);
  assert.equal(rows.length, 1);
  const s = rows[0];
  assert.equal(s.id, "2026-11-12T07-00-00-000Z_aaa");
  assert.equal(s.messages, 4, "和详情 total 口径一致，system 也算一条");
  assert.equal(s.model, "deepseek-flash");
  assert.equal(s.provider, "deepseek");
  assert.equal(s.preview, "私聊新消息（合并1条）");
  assert.deepEqual(s.pools, ["p1"]);
});

test("detail：默认最新一段，before 往前翻，工具调用和 usage 都在", () => {
  const id = "2026-11-12T07-00-00-000Z_aaa";
  const latest = readLlmSession(cfg, id, { limit: 2 })!;
  assert.equal(latest.total, 4);
  assert.equal(latest.messages.length, 2);
  assert.deepEqual(latest.messages.map((m) => m.index), [2, 3]);
  assert.equal(latest.next_before, 2);
  const assistant = latest.messages[0];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls?.[0]?.name, "chat");
  assert.match(assistant.tool_calls?.[0]?.args ?? "", /"action":"send"/);
  assert.equal(assistant.usage?.totalTokens, 6);
  const tool = latest.messages[1];
  assert.equal(tool.role, "toolResult");
  assert.equal(tool.tool_name, "chat");

  const older = readLlmSession(cfg, id, { limit: 2, before: latest.next_before! })!;
  assert.deepEqual(older.messages.map((m) => m.index), [0, 1]);
  assert.equal(older.next_before, null);
});

test("detail：非法 id / 不存在的会话返回 null", () => {
  assert.equal(readLlmSession(cfg, "../etc/passwd"), null);
  assert.equal(readLlmSession(cfg, "nope"), null);
});

test("detail：超长正文截断并标记", () => {
  const id = "2026-11-12T07-00-00-000Z_bbb";
  writeSession(id, [
    { type: "message", timestamp: "2026-11-12T07:00:05.000Z", message: { role: "user", content: "长".repeat(13_000) } },
  ]);
  const d = readLlmSession(cfg, id, { limit: 10 })!;
  assert.equal(d.messages.length, 5);
  const long = d.messages[d.messages.length - 1];
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, 12_000);
});
