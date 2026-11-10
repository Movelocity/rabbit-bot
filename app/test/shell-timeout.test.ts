/** UFA terminal 的 5 秒硬上限，以及 host 模式超时杀整组。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { createTools } from "../src/agent/tools.ts";
import { shellTimeoutSec } from "../src/ops/exec.ts";
import { runOnHost } from "../src/core/shell-runner.ts";

test("shellTimeoutSec：UFA 被 ufaMaxTimeoutMs 夹住，WA 仍可到 600", () => {
  const cfg = loadConfig({
    exec: { shell: { mode: "host", timeoutMs: 10000, ufaMaxTimeoutMs: 5000 } },
    approval: { enabled: false },
  });
  assert.equal(shellTimeoutSec("ufa", cfg), 5, "默认 10 秒也要被压到 5");
  assert.equal(shellTimeoutSec("ufa", cfg, 600), 5, "模型自己写 600 也不行");
  assert.equal(shellTimeoutSec("ufa", cfg, 2), 2);
  assert.equal(shellTimeoutSec("wa", cfg), 10);
  assert.equal(shellTimeoutSec("wa", cfg, 600), 600);

  assert.throws(() => loadConfig({ exec: { shell: { ufaMaxTimeoutMs: 0 } } }), /ufaMaxTimeoutMs/);
  assert.throws(() => loadConfig({ exec: { shell: { ufaMaxTimeoutMs: 600001 } } }), /不能超过/);
});

test("terminal 描述按 profile 说清上限", () => {
  const cfg = loadConfig({
    exec: { shell: { mode: "host", ufaMaxTimeoutMs: 5000 } },
    approval: { enabled: true },
  });
  const store = new Store(":memory:");
  const ufa = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa" }) as any[];
  const wa = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "wa" }) as any[];
  const ufaTerm = ufa.find((t) => t.name === "terminal");
  const waTerm = wa.find((t) => t.name === "terminal");
  assert.ok(ufaTerm && waTerm);
  assert.match(ufaTerm.description, /最多 5 秒/);
  assert.match(ufaTerm.description, /交给 WA/);
  assert.match(waTerm.description, /最多 600 秒/);
  store.close();
});

test("host 超时杀掉整个进程组，后台不再继续写", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-shell-"));
  const out = path.join(dir, "out.txt");
  const opts: any = {
    mode: "host", container: "x", image: "x", network: "none",
    volumes: [{ host: dir, container: "/work" }],
    timeoutMs: 700, maxOutputChars: 8000, hostCwd: dir,
  };
  const cmd = `for i in $(seq 1 40); do echo x >> '${out}'; sleep 0.1; done`;
  const t0 = Date.now();
  const r = await runOnHost(cmd, opts);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.match(r.output, /超过 1 秒被终止/);
  assert.ok(elapsed < 3000, `应该 1 秒左右返回，实际 ${elapsed}ms`);

  await new Promise((res) => setTimeout(res, 800));
  const n1 = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length : 0;
  await new Promise((res) => setTimeout(res, 800));
  const n2 = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length : 0;
  assert.equal(n2, n1, "超时后进程组应被杀，文件不再增长");
  assert.ok(n1 < 40, "不该跑完");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("host 快速命令仍然正常返回", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-shell-ok-"));
  const opts: any = {
    mode: "host", container: "x", image: "x", network: "none",
    volumes: [{ host: dir, container: "/work" }],
    timeoutMs: 5000, maxOutputChars: 8000, hostCwd: dir,
  };
  const r = await runOnHost("echo hi", opts);
  assert.equal(r.ok, true);
  assert.match(r.output, /hi/);
  fs.rmSync(dir, { recursive: true, force: true });
});
