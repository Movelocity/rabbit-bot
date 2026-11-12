/** UFA 不再有 edit_prompt：提示词就在沙盒卷里，直接改文件。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

test("UFA 工具集不再包含 edit_prompt / plan / write_file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-no-edit-prompt-"));
  const store = new Store(":memory:");
  try {
    const cfg = loadConfig({ runtimeDir: dir, exec: { shell: { mode: "docker" } } });
    const tools = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa" }) as any[];
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("edit_prompt"), `edit_prompt 该下线：${names.join(",")}`);
    assert.ok(!names.includes("plan"), `目标看板该下线：${names.join(",")}`);
    assert.ok(!names.includes("write_file"), `UFA 不该有 write_file：${names.join(",")}`);
    assert.ok(names.includes("read_file"), "read_file 要留着");
    assert.ok(names.includes("edit_file"), "edit_file 要留着");
    assert.ok(names.includes("terminal"), "沙盒里 terminal 要留着");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
