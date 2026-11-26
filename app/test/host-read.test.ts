/** read_file：默认读沙盒；host 读取走白名单，白名单外申请审批。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import {
  addHostReadRoot, checkHostRead, hostReadSettings, listHostReadLog, removeHostReadRoot, setUnknownPolicy,
} from "../src/core/host-read.ts";

function setup(opts: { decision?: "approved" | "rejected"; allowHostRoot?: boolean; configuredVolume?: boolean } = {}) {
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
      shell: {
        mode: "docker",
        ...(opts.configuredVolume ? { volumes: [{ host: hostDir, container: "/work/extra" }] } : {}),
        host: { readRoots: opts.allowHostRoot ? [hostDir] : [] },
      },
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

test("host 白名单外的代码/文档直接读，记一条 auto", async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.hostDir, "a.ts"), "export const a = 1;");
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "a.ts") });
    assert.equal(r.details.ok, true);
    assert.equal(s.asked.length, 0, "代码文件不该申请");
    const log = listHostReadLog(s.store);
    assert.equal(log[0].outcome, "auto");
    assert.equal(log[0].rule, "ext");
  } finally { cleanup(s); }
});

test("未登记类型：批准只放行这一次，下次还问", async () => {
  const s = setup({ decision: "approved" });
  try {
    const f = path.join(s.hostDir, "data.bin");
    fs.writeFileSync(f, "plain text");
    const r: any = await s.read.execute("id", { scope: "host", path: f });
    assert.equal(r.details.ok, true);
    assert.equal(text(r), "plain text");
    assert.equal(s.asked.length, 1);
    await s.read.execute("id", { scope: "host", path: f });
    assert.equal(s.asked.length, 2, "批准不进白名单");
    assert.equal(listHostReadLog(s.store, { outcome: "approved" }).length, 2);
  } finally { cleanup(s); }
});

test("host 申请被拒就不读", async () => {
  const s = setup({ decision: "rejected" });
  try {
    fs.writeFileSync(path.join(s.hostDir, ".env"), "TOKEN=x");
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, ".env") });
    assert.equal(r.details.ok, false);
    assert.match(text(r), /没批/);
    assert.doesNotMatch(text(r), /TOKEN=x/);
    assert.equal(listHostReadLog(s.store)[0].outcome, "rejected");
  } finally { cleanup(s); }
});

test("白名单目录里的 .env 照样要审批；.env.example 直接读", async () => {
  const s = setup({ allowHostRoot: true, decision: "rejected" });
  try {
    fs.writeFileSync(path.join(s.hostDir, ".env"), "TOKEN=x");
    fs.writeFileSync(path.join(s.hostDir, ".env.example"), "TOKEN=");
    const secret: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, ".env") });
    assert.equal(secret.details.ok, false);
    assert.equal(s.asked.length, 1);
    const tpl: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, ".env.example") });
    assert.equal(tpl.details.ok, true);
    assert.equal(s.asked.length, 1, "模板不该申请");
  } finally { cleanup(s); }
});

test("白名单目录里的软链指向密钥：按真实路径判，要审批", async () => {
  const s = setup({ allowHostRoot: true, decision: "rejected" });
  try {
    const outside = path.join(s.dir, "keys");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "server.pem"), "-----BEGIN PRIVATE KEY-----");
    fs.symlinkSync(path.join(outside, "server.pem"), path.join(s.hostDir, "notes.md"));
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "notes.md") });
    assert.equal(r.details.ok, false);
    assert.equal(s.asked.length, 1);
  } finally { cleanup(s); }
});

test("白名单目录里的未登记类型直接读", async () => {
  const s = setup({ allowHostRoot: true });
  try {
    fs.writeFileSync(path.join(s.hostDir, "data.bin"), "x");
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "data.bin") });
    assert.equal(r.details.ok, true);
    assert.equal(s.asked.length, 0);
    assert.equal(listHostReadLog(s.store)[0].rule, "dir");
  } finally { cleanup(s); }
});

test("旧白名单（字符串数组）迁移：只留存在的目录，单文件和坏条目丢掉", () => {
  const s = setup();
  try {
    const file = path.join(s.dir, "data", "run", "host-read-allow.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([s.hostDir, path.join(s.hostDir, "host.txt"), "/nope/x *"]));
    const cfg = loadConfig({ runtimeDir: s.runtime, dataDir: path.join(s.dir, "data"), exec: { dir: s.runtime, shell: { mode: "docker" } } });
    const st = hostReadSettings(cfg);
    const web = st.roots.filter((r) => r.source === "web");
    assert.deepEqual(web.map((r) => r.path), [fs.realpathSync(s.hostDir)]);
    assert.equal(st.unknown, "ask");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2, "迁移后写回新格式");
  } finally { cleanup(s); }
});

test("管理台加/删白名单目录；不收文件和家目录", () => {
  const s = setup();
  try {
    const cfg = loadConfig({ runtimeDir: s.runtime, dataDir: path.join(s.dir, "data"), exec: { dir: s.runtime, shell: { mode: "docker" } } });
    assert.throws(() => addHostReadRoot(cfg, path.join(s.hostDir, "host.txt")), /不是已存在的目录/);
    assert.throws(() => addHostReadRoot(cfg, os.homedir()), /家目录/);
    assert.throws(() => addHostReadRoot(cfg, "relative/dir"), /绝对路径/);
    addHostReadRoot(cfg, s.hostDir, "测试");
    assert.equal(checkHostRead(cfg, path.join(s.hostDir, "data.bin")).rule, "dir");
    assert.equal(removeHostReadRoot(cfg, s.hostDir), true);
    assert.equal(checkHostRead(cfg, path.join(s.hostDir, "data.bin")).verdict, "ask");
    setUnknownPolicy(cfg, "allow");
    assert.equal(checkHostRead(cfg, path.join(s.hostDir, "data.bin")).verdict, "allow");
  } finally { cleanup(s); }
});

test("scope=sandbox 接受 /work 和 /shared 别名", async () => {
  const s = setup();
  try {
    fs.mkdirSync(path.join(s.runtime, "shared/issues"), { recursive: true });
    fs.writeFileSync(path.join(s.runtime, "shared/issues/a.md"), "issue ok");
    for (const p of ["/work/shared/issues/a.md", "/shared/issues/a.md"]) {
      const r: any = await s.read.execute("id", { path: p });
      assert.equal(r.details.ok, true, p);
      assert.equal(text(r), "issue ok", p);
    }
    assert.equal(s.asked.length, 0);
  } finally { cleanup(s); }
});

test("已配置 volume 的宿主目录直接可读，不申请", async () => {
  const s = setup({ configuredVolume: true });
  try {
    const r: any = await s.read.execute("id", { scope: "host", path: path.join(s.hostDir, "host.txt") });
    assert.equal(r.details.ok, true);
    assert.equal(text(r), "host ok");
    assert.equal(s.asked.length, 0, "配置成 volume 的路径不该申请");
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
