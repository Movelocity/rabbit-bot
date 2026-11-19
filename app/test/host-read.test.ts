/** read_file：默认读沙盒；host 读取走白名单，白名单外申请审批。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

function setup(opts: { decision?: "approved" | "rejected"; allowHostRoot?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-host-read-"));
  const runtime = path.join(dir, "runtime");
  const hostDir = path.join(dir, "host");
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(runtime, "sandbox.txt"), "sandbox ok");
  fs.writeFileSync(path.join(hostDir, "host.txt"), "host ok");
  const cfg = loadConfig({
    runtimeDir: runtime,
    dataDir: path.join(dir, "data"),
    exec: {
      dir: runtime,
      shell: { mode: "docker", host: { readRoots: opts.allowHostRoot ? [hostDir] : [] } },
    },
  });
  const asked: string[] = [];
  const gate = {
    enabled: true,
    request: async (req: { cmd: string }) => {
      asked.push(req.cmd);
      return { id: 1, decision: opts.decision ?? "approved", latencyMs: 1 };
    },
    reportDone: () => undefined,
  };
  const store = new Store(":memory:");
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa",
    readRoot: runtime, approval: gate as any,
  }) as any[];
  const read = tools.find((t) => t.name === "read_file");
  return { dir, runtime, hostDir, store, read, asked };
}

const text = (r: any): string => (r.content ?? []).map((c: any) => c.text ?? "").join("");
const cleanup = (s: ReturnType<typeof setup>) => { s.store.close(); fs.rmSync(s.dir, { recursive: true, force: true }); };

test("默认 scope=sandbox，读 /work 不需要审批", async () => {
  const s = setup();
  try {
    const r: any = await s.read.execute("id", { path: "sandbox.txt" });
    assert.equal(r.details.ok, true);
    assert.equal(text(r), "sandbox ok");
    assert.equal(s.asked.length, 0);
  } finally { cleanup(s); }
});

test("host 白名单内的文件直接读，不申请", async () => {
  const s = setup({ allowHostRoot: true });
  try {
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "host.txt") });
    assert.equal(r.details.ok, true);
    assert.equal(text(r), "host ok");
    assert.equal(s.asked.length, 0, "白名单内不该申请");
  } finally { cleanup(s); }
});

test("host 白名单外：批准后读，并记进白名单；第二次不再申请", async () => {
  const s = setup({ decision: "approved" });
  try {
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "host.txt") });
    assert.equal(r.details.ok, true);
    assert.equal(text(r), "host ok");
    assert.equal(s.asked.length, 1);
    const again: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "host.txt") });
    assert.equal(again.details.ok, true);
    assert.equal(s.asked.length, 1, "批准过一次后应进白名单");
  } finally { cleanup(s); }
});

test("host 白名单外：被拒就不读", async () => {
  const s = setup({ decision: "rejected" });
  try {
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "host.txt") });
    assert.equal(r.details.ok, false);
    assert.match(text(r), /没批/);
  } finally { cleanup(s); }
});

test("sandbox 下给绝对路径：沙盒内自动转相对，沙盒外自动按 host 走审批", async () => {
  const s = setup({ decision: "approved" });
  try {
    const inSandbox: any = await s.read.execute("id", { path: path.join(s.runtime, "sandbox.txt") });
    assert.equal(inSandbox.details.ok, true);
    assert.equal(text(inSandbox), "sandbox ok");
    assert.equal(s.asked.length, 0, "沙盒内绝对路径不该申请");

    const onHost: any = await s.read.execute("id", { path: path.join(s.hostDir, "host.txt") });
    assert.equal(onHost.details.ok, true);
    assert.equal(text(onHost), "host ok");
    assert.equal(s.asked.length, 1, "沙盒外绝对路径应自动走 host 审批");
  } finally { cleanup(s); }
});

test("读目录时直接返回列表，而不是报「不是文件」", async () => {
  const s = setup();
  try {
    fs.mkdirSync(path.join(s.runtime, "shared/projects"), { recursive: true });
    fs.writeFileSync(path.join(s.runtime, "shared/projects/a.md"), "x");
    const r: any = await s.read.execute("id", { path: "shared/projects" });
    assert.equal(r.details.ok, true);
    assert.equal(r.details.dir, true);
    assert.match(text(r), /这是目录/);
    assert.match(text(r), /shared\/projects\/a\.md/);
  } finally { cleanup(s); }
});

test("文件不存在时提示相对路径 / terminal ls / scope=host", async () => {
  const s = setup();
  try {
    const r: any = await s.read.execute("id", { path: "prompt/nope.md" });
    assert.equal(r.details.ok, false);
    assert.match(text(r), /没有这个文件/);
    assert.match(text(r), /terminal ls/);
    assert.match(text(r), /scope="host"/);
  } finally { cleanup(s); }
});
