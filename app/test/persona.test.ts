import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPersona, personaPath } from "../src/agent/persona.ts";
import { loadConfig } from "../src/config.ts";

const cfg = { ...loadConfig(), agent: { name: "小池", persona: "配置里的人设" } } as any;

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

test("没有运行时人设时，路径指向仓库里的 config/persona.md", () => {
  const c = { ...cfg, runtimeDir: path.join(os.tmpdir(), "rabbit-bot-no-runtime") } as any;
  assert.match(personaPath(c), /config[\\/]persona\.md$/);
});

test("运行时目录里有人设就优先用它（真身在仓库外）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-runtime-"));
  fs.writeFileSync(path.join(dir, "persona.md"), "运行时的人设");
  const c = { ...cfg, runtimeDir: dir } as any;
  assert.equal(personaPath(c), path.join(dir, "persona.md"));
  assert.equal(loadPersona(c), "运行时的人设");
});

test("运行时目录空着 → 用仓库里的默认人设", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-runtime-empty-"));
  const c = { ...cfg, runtimeDir: dir } as any;
  assert.match(personaPath(c), /config[\\/]persona\.md$/);
  const text = loadPersona(c);
  assert.match(text, /^# 小池/);
  assert.ok(text.includes("项目经理"), "默认人设要写清角色，不是一句占位");
  assert.ok(text.includes("决策压到最少"), "默认人设要带目标，不是一句占位");
});

test("提示词、人设、默认配置不写死本机用户名", () => {
  const prompts = path.resolve(import.meta.dirname, "../prompts");
  const files = [
    ...fs.readdirSync(prompts).filter((f) => f.endsWith(".md")).map((f) => path.join(prompts, f)),
    path.resolve(import.meta.dirname, "../config/persona.md"),
    path.resolve(import.meta.dirname, "../config/default.json"),
  ];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(text, /\/Users\/[A-Za-z0-9._-]+/, `${f} 写死了本机路径，应该用 ~ 或配置展开`);
  }
});
