import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPersona, personaPath } from "../src/agent/persona.ts";
import { loadConfig } from "../src/config.ts";

const cfg = { ...loadConfig(), agent: { name: "克劳德", persona: "配置里的人设" } } as any;

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-persona-")), name);
}

test("没有 persona.md 时退回 config.agent.persona（文件缺失不该让进程起不来）", () => {
  const missing = tmpFile("nope.md");
  assert.equal(loadPersona(cfg, missing), "配置里的人设");
});

test("有 persona.md 时用文件内容，忽略 config", () => {
  const f = tmpFile("persona.md");
  fs.writeFileSync(f, "  文件里的人设  \n");
  assert.equal(loadPersona(cfg, f), "文件里的人设", "首尾空白该被剪掉");
});

test("空文件不算数：退回 config", () => {
  const f = tmpFile("empty.md");
  fs.writeFileSync(f, "   \n\n  ");
  assert.equal(loadPersona(cfg, f), "配置里的人设");
});

test("改了文件，下一轮就读到新的（不用重启）", async () => {
  const f = tmpFile("persona.md");
  fs.writeFileSync(f, "第一版");
  assert.equal(loadPersona(cfg, f), "第一版");
  // 等一个 tick，避免 mtime 相同
  await new Promise((r) => setTimeout(r, 12));
  fs.writeFileSync(f, "第二版，加了一节干活时的习惯");
  assert.equal(loadPersona(cfg, f), "第二版，加了一节干活时的习惯");
});

test("没改文件时走缓存（同一个字符串）", () => {
  const f = tmpFile("persona.md");
  fs.writeFileSync(f, "缓存测试");
  const a = loadPersona(cfg, f);
  const b = loadPersona(cfg, f);
  assert.equal(a, b);
  assert.equal(a, "缓存测试");
});

test("真实路径指向 config/persona.md", () => {
  assert.match(personaPath(), /config[\\/]persona\.md$/);
});
