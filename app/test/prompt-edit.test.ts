/** UFA 自编辑提示词：prompt/*.md 可改，system.md 不行。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

test("edit_prompt：改非 system 提示词、拒绝改 system、replace 校验 old", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-edit-prompt-"));
  const runtime = path.join(dir, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const store = new Store(":memory:");
  try {
    const cfg = loadConfig({ runtimeDir: runtime });
    const tools = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa" }) as any[];
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("edit_prompt"), `UFA 该有 edit_prompt：${names.join(",")}`);
    assert.ok(!names.includes("write_file"), `UFA 不该有 write_file：${names.join(",")}`);

    const tool = tools.find((t) => t.name === "edit_prompt");
    const list: any = await tool.execute("id", { action: "list" });
    assert.equal(list.details?.ok, true);
    assert.match(list.content[0].text, /scene-message/);

    const replaced: any = await tool.execute("id", {
      action: "replace", name: "scene-message", old: "【这一轮】", new: "【这一轮·改】",
    });
    assert.equal(replaced.details?.ok, true, JSON.stringify(replaced.details));
    const file = path.join(runtime, "prompt", "scene-message.md");
    assert.match(fs.readFileSync(file, "utf8"), /【这一轮·改】/);

    const read: any = await tool.execute("id", { action: "read", name: "prompt/scene-message.md" });
    assert.equal(read.details?.ok, true);
    assert.match(read.content[0].text, /【这一轮·改】/);

    const missing: any = await tool.execute("id", {
      action: "replace", name: "scene-message", old: "这段原文不存在-xyz", new: "x",
    });
    assert.equal(missing.details?.ok, false);

    const blocked: any = await tool.execute("id", { action: "write", name: "system", content: "改总纲" });
    assert.equal(blocked.details?.ok, false);
    assert.match(blocked.content[0].text, /总纲/);
    const systemFile = path.join(runtime, "prompt", "system.md");
    if (fs.existsSync(systemFile)) {
      assert.doesNotMatch(fs.readFileSync(systemFile, "utf8"), /改总纲/, "system.md 不该被自改");
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
