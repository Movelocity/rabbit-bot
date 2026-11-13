/** edit_file：沙盒内整份写 / 唯一替换，不用 terminal 拼 heredoc。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { WORKING_MEMORY_MAX_CHARS } from "../src/core/working-memory.ts";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-edit-file-"));
  const runtime = path.join(dir, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const cfg = loadConfig({ runtimeDir: runtime, exec: { dir: runtime, shell: { mode: "docker" } } });
  const store = new Store(":memory:");
  const tools = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa", readRoot: runtime }) as any[];
  const edit = tools.find((t) => t.name === "edit_file");
  return { dir, runtime, store, edit };
}

const text = (r: any): string => (r.content ?? []).map((c: any) => c.text ?? "").join("");
const cleanup = (s: ReturnType<typeof setup>) => { s.store.close(); fs.rmSync(s.dir, { recursive: true, force: true }); };

test("write：整份覆盖，落到 /work 对应文件", async () => {
  const s = setup();
  try {
    const r: any = await s.edit.execute("id", { action: "write", path: "prompt/scene-message.md", content: "新内容" });
    assert.equal(r.details.ok, true, text(r));
    assert.equal(fs.readFileSync(path.join(s.runtime, "prompt/scene-message.md"), "utf8"), "新内容");
  } finally { cleanup(s); }
});

test("memory.md：edit_file 写入和替换都受 4000 字上限约束", async () => {
  const s = setup();
  try {
    const tooLong = "长".repeat(WORKING_MEMORY_MAX_CHARS + 1);
    const write: any = await s.edit.execute("id", { action: "write", path: "memory.md", content: tooLong });
    assert.equal(write.details.ok, false);
    assert.match(text(write), /超过上限/);

    const ok: any = await s.edit.execute("id", { action: "write", path: "memory.md", content: "短" });
    assert.equal(ok.details.ok, true, text(ok));

    const replace: any = await s.edit.execute("id", { action: "replace", path: "memory.md", old: "短", new: tooLong });
    assert.equal(replace.details.ok, false);
    assert.match(text(replace), /超过上限/);
    assert.equal(fs.readFileSync(path.join(s.runtime, "memory.md"), "utf8"), "短");
  } finally { cleanup(s); }
});

test("replace：old 必须唯一命中", async () => {
  const s = setup();
  try {
    fs.mkdirSync(path.join(s.runtime, "prompt"), { recursive: true });
    fs.writeFileSync(path.join(s.runtime, "prompt", "scene-message.md"), "a\nb\na\n");
    const dup: any = await s.edit.execute("id", { action: "replace", path: "prompt/scene-message.md", old: "a", new: "A" });
    assert.equal(dup.details.ok, false);
    assert.match(text(dup), /不唯一/);
    const ok: any = await s.edit.execute("id", { action: "replace", path: "prompt/scene-message.md", old: "a\nb", new: "A\nb" });
    assert.equal(ok.details.ok, true, text(ok));
    assert.equal(fs.readFileSync(path.join(s.runtime, "prompt/scene-message.md"), "utf8"), "A\nb\na\n");
  } finally { cleanup(s); }
});
