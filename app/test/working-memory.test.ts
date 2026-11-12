import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { systemPrompt } from "../src/agent/prompt.ts";
import { createTools } from "../src/agent/tools.ts";
import {
  addWorkingMemory, ensureWorkingMemory, readWorkingMemory, removeWorkingMemory,
  replaceWorkingMemory, workingMemoryPath, WORKING_MEMORY_MAX_CHARS,
} from "../src/core/working-memory.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-working-memory-"));
  const cfg = loadConfig({ runtimeDir: dir, exec: { shell: { mode: "docker" } } });
  return {
    dir,
    cfg,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("memory.md 默认落在运行时目录，缺失时读取为空", () => {
  const x = fixture();
  try {
    assert.equal(workingMemoryPath(x.cfg), path.join(x.dir, "memory.md"));
    const wm = readWorkingMemory(x.cfg);
    assert.equal(wm.content, "");
    assert.equal(wm.chars, 0);
    assert.equal(wm.limit, WORKING_MEMORY_MAX_CHARS);
  } finally { x.cleanup(); }
});

test("add / replace / remove 操作 memory.md", () => {
  const x = fixture();
  try {
    ensureWorkingMemory(x.cfg);
    assert.ok(fs.existsSync(workingMemoryPath(x.cfg)));

    const added = addWorkingMemory(x.cfg, "正在改记忆注入，等下次会话生效");
    assert.equal(added.content, "- 正在改记忆注入，等下次会话生效");

    const replaced = replaceWorkingMemory(x.cfg, "记忆注入", "工作记忆注入");
    assert.match(replaced.content, /工作记忆注入/);
    assert.doesNotMatch(replaced.content, /正在改记忆注入/);

    const removed = removeWorkingMemory(x.cfg, "工作记忆注入");
    assert.equal(removed.removed, 1);
    assert.equal(removed.state.content, "");
  } finally { x.cleanup(); }
});

test("replace 要求 old 唯一；超出上限拒绝写入", () => {
  const x = fixture();
  try {
    addWorkingMemory(x.cfg, "同一件事");
    addWorkingMemory(x.cfg, "同一件事");
    assert.throws(() => replaceWorkingMemory(x.cfg, "同一件事", "改了"), /匹配到 2 处/);
    assert.throws(() => removeWorkingMemory(x.cfg, "同一件事"), /匹配到 2 行/);
    assert.throws(
      () => addWorkingMemory(x.cfg, "长".repeat(WORKING_MEMORY_MAX_CHARS)),
      /超过上限/,
    );
  } finally { x.cleanup(); }
});

test("system prompt 末尾注入工作记忆（便于前缀缓存命中）", () => {
  const x = fixture();
  const store = new Store(":memory:");
  try {
    addWorkingMemory(x.cfg, "当前目标：把 memory.md 接进会话");
    const prompt = systemPrompt(x.cfg, [], store);
    const block = "## 工作记忆（跨会话共享）";
    assert.ok(prompt.includes(block));
    assert.ok(prompt.includes("当前目标：把 memory.md 接进会话"));
    assert.ok(prompt.indexOf(block) > prompt.indexOf("[当前状态]"));
  } finally {
    store.close();
    x.cleanup();
  }
});

test("working_memory 工具可以读写", async () => {
  const x = fixture();
  const store = new Store(":memory:");
  try {
    const tools = createTools({
      store, hub: {} as any, cfg: x.cfg, now: () => Date.parse("2026-11-12T10:00:00+08:00"), profile: "ufa",
    }) as any[];
    const tool = tools.find((t) => t.name === "working_memory");
    assert.ok(tool, `缺少 working_memory 工具：${tools.map((t) => t.name).join(",")}`);

    const added = await tool.execute("t1", { action: "add", content: "等主人确认记忆注入" });
    assert.equal(added.details.ok, true);

    const read = await tool.execute("t2", { action: "read" });
    assert.match(read.content[0].text, /等主人确认记忆注入/);

    const removed = await tool.execute("t3", { action: "remove", old: "等主人确认" });
    assert.equal(removed.details.ok, true);
    assert.equal(readWorkingMemory(x.cfg).content, "");
  } finally {
    store.close();
    x.cleanup();
  }
});
