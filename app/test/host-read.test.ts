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
