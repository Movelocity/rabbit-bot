/**
 * 接线验收：host 模式下 terminal 真的先过分类与审批，再动宿主机。
 * 用的是真 shell、真目录，只是审批那一步换成假的（不然要连 Matrix）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

function setup(decision: "approved" | "rejected" | "timeout" | "disabled", opts: { hasGate?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-host-"));
  const cfg = loadConfig();
  cfg.exec.dir = dir;
  cfg.exec.shell.mode = "host";
  cfg.exec.shell.host = { cwd: dir, inheritEnv: false };

  const asked: { cmd: string; why: string }[] = [];
  const reported: { id: number; ok: boolean; code: number }[] = [];
  const store = new Store(":memory:");
  const gate = {
    enabled: decision !== "disabled",
    request: async (req: { cmd: string; why: string }) => {
      asked.push(req);
      return { id: 42, decision: decision === "disabled" ? "disabled" : decision, latencyMs: 1 };
    },
    reportDone: (id: number, info: { ok: boolean; code: number }) => { reported.push({ id, ...info }); },
  };
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(), profile: "wa",
    ...(opts.hasGate === false ? {} : { approval: gate as any }),
  }) as any[];
  const terminal = tools.find((t) => t.name === "terminal")!;
  const run = async (cmd: string) => {
    const r: any = await terminal.execute("id", { cmd });
    const text = Array.isArray(r.content) ? r.content.map((c: any) => c?.text ?? "").join("") : String(r.content ?? "");
    return { text, details: r.details ?? {} };
  };
  return { dir, run, asked, reported };
}

test("safe 档：直接跑，不惊动审批", async () => {
  const { dir, run, asked } = setup("rejected");
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  const r = await run("ls");
  assert.match(r.text, /a\.txt/);
  assert.equal(asked.length, 0);
});

test("ask 档被拒：不执行，目录还在，并通知引擎打断本轮", async () => {
  const { dir, run, asked } = setup("rejected");
  fs.mkdirSync(path.join(dir, "build"));
  const r = await run("rm -rf build");
  assert.equal(asked.length, 1);
  assert.match(r.text, /主人说不行/);
  assert.match(r.text, /本轮到此为止/);
  assert.equal(r.details.halt, "approval-rejected", "被拒后要让引擎强制收手，不能换命令重试");
  assert.equal(fs.existsSync(path.join(dir, "build")), true, "被拒了还删掉了，闸门形同虚设");
});

test("ask 档获批：真的在宿主机上跑，并把结果序号回报", async () => {
  const { dir, run, reported } = setup("approved");
  fs.mkdirSync(path.join(dir, "build"));
  const r = await run("rm -rf build");
  assert.equal(fs.existsSync(path.join(dir, "build")), false);
  assert.equal(r.details.ok, true);
  assert.equal(reported.length, 1, "批完执行完要回报一次");
  assert.equal(reported[0].id, 42);
  assert.equal(reported[0].ok, true);
});

test("超时：不执行", async () => {
  const { dir, run } = setup("timeout");
  fs.mkdirSync(path.join(dir, "build"));
  const r = await run("rm -rf build");
  assert.match(r.text, /没等到批准/);
  assert.equal(r.details.halt, "approval-timeout");
  assert.equal(fs.existsSync(path.join(dir, "build")), true);
});

test("deny 档：不问，直接拒", async () => {
  const { run, asked } = setup("approved");
  const r = await run("cat ~/.config/rabbit-bot/env");
  assert.equal(asked.length, 0, "凭据不该走到审批这一步");
  assert.match(r.text, /这条不许跑/);
});

test("审批没开：ask 档一律不许跑（fail-closed）", async () => {
  const { dir, run, asked } = setup("disabled", { hasGate: false });
  fs.mkdirSync(path.join(dir, "build"));
  const r = await run("rm -rf build");
  assert.match(r.text, /审批没开/);
  assert.equal(fs.existsSync(path.join(dir, "build")), true);
  assert.equal(asked.length, 0);
});
