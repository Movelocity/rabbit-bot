/** UFA：沙盒模式始终有 terminal；宿主机模式必须有审批。WA 始终有 terminal。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

function namesFor(profile: "ufa" | "wa", mode: "host" | "docker", approval: boolean): string[] {
  // 显式覆盖，别依赖本机 config/local.json
  const cfg = loadConfig({ exec: { shell: { mode } }, approval: { enabled: approval } });
  const tools = createTools({
    store: new Store(":memory:"), hub: {} as any, cfg, now: () => Date.now(), profile,
  }) as any[];
  return tools.map((t) => t.name);
}

test("UFA：host + approval=true 时包含 terminal", () => {
  const names = namesFor("ufa", "host", true);
  assert.ok(names.includes("terminal"), `该有 terminal：${names.join(",")}`);
  for (const name of ["chat", "memory", "plan", "approval", "task", "worker", "read_file", "rb"]) {
    assert.ok(names.includes(name), `UFA 少了 ${name}：${names.join(",")}`);
  }
  assert.ok(!names.includes("write_file"), `UFA 不该有 write_file：${names.join(",")}`);
});

test("UFA：docker 模式始终有 terminal；host 无审批时没有", () => {
  for (const approval of [true, false]) {
    const names = namesFor("ufa", "docker", approval);
    assert.ok(names.includes("terminal"), `docker/${approval} 该有 terminal：${names.join(",")}`);
  }
  const noApproval = namesFor("ufa", "host", false);
  assert.ok(!noApproval.includes("terminal"), `host/审批关不该给 terminal：${noApproval.join(",")}`);
});

test("WA：始终有 terminal，且没有 chat/task/approval", () => {
  for (const [mode, approval] of [["host", true], ["docker", false]] as const) {
    const names = namesFor("wa", mode, approval);
    assert.deepEqual([...names].sort(), ["rb", "read_file", "terminal", "write_file"]);
  }
});

test("UFA read_file 固定在 runtime 根，不跟着 exec.dir 漂", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-readroot-"));
  const runtime = path.join(dir, "runtime");
  const execDir = path.join(dir, "elsewhere");
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(runtime, "ok.md"), "runtime 里的内容");
  fs.writeFileSync(path.join(execDir, "secret.md"), "exec.dir 里的内容");
  const cfg = loadConfig({ runtimeDir: runtime, exec: { dir: execDir, shell: { mode: "docker" } } });
  const tools = createTools({
    store: new Store(":memory:"), hub: {} as any, cfg, now: () => Date.now(),
    profile: "ufa", readRoot: runtime,
  }) as any[];
  const read = tools.find((t) => t.name === "read_file");
  const ok: any = await read.execute("id", { path: "ok.md" });
  assert.equal(ok.details?.ok, true);
  assert.match(ok.content.map((c: any) => c.text ?? "").join(""), /runtime 里的内容/);
  const bad: any = await read.execute("id", { path: "../elsewhere/secret.md" });
  assert.equal(bad.details?.ok, false, "越界到 exec.dir 必须被挡住");
  fs.rmSync(dir, { recursive: true, force: true });
});
