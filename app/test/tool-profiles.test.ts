/** UFA：沙盒模式始终有 terminal；宿主机模式必须有审批。WA 始终有 terminal。 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
  for (const name of ["chat", "memory", "plan", "approval", "task", "worker", "read_file", "write_file", "rb"]) {
    assert.ok(names.includes(name), `UFA 少了 ${name}：${names.join(",")}`);
  }
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
