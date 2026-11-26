/** 宿主读取管理 API：白名单改动和宿主机审批只认浏览器登录会话；Web 裁决能立刻放行正在等的闸门。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { ApprovalGate } from "../src/core/approval.ts";
import { getApproval } from "../src/core/approvals.ts";
import { logHostRead } from "../src/core/host-read.ts";
import { startApiServer } from "../src/api.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-host-read-api-"));
const oldPasswordEnv = process.env.RABBIT_BOT_WEB_PASSWORD;
delete process.env.RABBIT_BOT_WEB_PASSWORD;

const projDir = path.join(dir, "proj");
fs.mkdirSync(projDir, { recursive: true });

const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: path.join(dir, "sandbox"), sharedSkillsDir: "" },
  webChat: { enabled: true, username: "rabbit-bot", pool: "web-chat", title: "网页直聊", sessionDays: 30 },
});
const store = new Store(path.join(dir, "test.db"));
const log = new Logger(null, true);
const token = "h".repeat(32);
const sent: string[] = [];
const gate = new ApprovalGate(
  { enabled: true, platform: "matrix", roomId: "!room:test", ownerIds: ["@owner:test"], timeoutMs: 5000, notify: false },
  log,
  async (_c, t) => { sent.push(t); return { ok: true, msgId: "evt1" }; },
  undefined,
  { store },
);

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";
let session = "";

test.before(async () => {
  server = await startApiServer({ cfg, store, log, token, hostGate: gate });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const r = await call("/v1/auth/setup", { auth: null, method: "POST", body: JSON.stringify({ password: "rabbit-2026" }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  session = r.body.data.token;
});

test.after(() => {
  server?.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (oldPasswordEnv === undefined) delete process.env.RABBIT_BOT_WEB_PASSWORD;
  else process.env.RABBIT_BOT_WEB_PASSWORD = oldPasswordEnv;
});

async function call(p: string, init: RequestInit & { auth?: string | null } = {}) {
  const { auth, ...rest } = init;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth ?? `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { ...rest, headers });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const asSession = () => `Bearer ${session}`;

test("API token 能看，不能改白名单 / 策略", async () => {
  const get = await call("/v1/host-read");
  assert.equal(get.status, 200);
  assert.equal(get.body.data.unknown, "ask");
  const add = await call("/v1/host-read/roots", { method: "POST", body: JSON.stringify({ path: projDir }) });
  assert.equal(add.status, 403);
  const put = await call("/v1/host-read", { method: "PUT", body: JSON.stringify({ unknown: "allow" }) });
  assert.equal(put.status, 403);
});

test("登录会话：加目录 → 试算命中 → 删目录", async () => {
  const add = await call("/v1/host-read/roots", { auth: asSession(), method: "POST", body: JSON.stringify({ path: projDir, note: "项目" }) });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const real = fs.realpathSync(projDir);
  assert.ok(add.body.data.roots.some((r: any) => r.path === real && r.source === "web" && r.note === "项目"));

  const chk = await call(`/v1/host-read/check?path=${encodeURIComponent(path.join(projDir, "x.sqlite"))}`);
  assert.equal(chk.body.data.verdict, "allow");
  assert.equal(chk.body.data.rule, "dir");

  const bad = await call("/v1/host-read/roots", { auth: asSession(), method: "POST", body: JSON.stringify({ path: "rel/dir" }) });
  assert.equal(bad.status, 400);

  const del = await call(`/v1/host-read/roots?path=${encodeURIComponent(projDir)}`, { auth: asSession(), method: "DELETE" });
  assert.equal(del.status, 200);
  const again = await call(`/v1/host-read/check?path=${encodeURIComponent(path.join(projDir, "x.sqlite"))}`);
  assert.equal(again.body.data.verdict, "ask");
});

test("读取记录可按结果筛选，asked = 发生过审批的", async () => {
  logHostRead(store, { path: "/a.ts", outcome: "auto", rule: "ext", why: "", approval_id: null, by: null });
  logHostRead(store, { path: "/b/.env", outcome: "rejected", rule: "secret", why: "", approval_id: 9, by: "@owner:test" });
  const all = await call("/v1/host-read/log");
  assert.equal(all.body.data.length, 2);
  assert.equal(all.body.data[0].path, "/b/.env", "新的在前");
  const asked = await call("/v1/host-read/log?outcome=asked");
  assert.deepEqual(asked.body.data.map((r: any) => r.path), ["/b/.env"]);
  const q = await call("/v1/host-read/log?q=a.ts");
  assert.deepEqual(q.body.data.map((r: any) => r.path), ["/a.ts"]);
  const st = await call("/v1/host-read");
  assert.equal(st.body.data.stats.day.auto, 1);
});

test("宿主机审批：token 批不了；登录会话批了，正在等的读取立刻放行", async () => {
  const pending = gate.request({ cmd: "/x/.env", cwd: "/x", why: "读取宿主文件", kind: "read" });
  // 等审批提示发出去、落库
  for (let i = 0; i < 50 && gate.pendingRowId === null; i++) await new Promise((r) => setTimeout(r, 10));
  const rowId = gate.pendingRowId!;
  assert.ok(rowId);
  assert.match(getApproval(store, rowId)!.action, /^read: \/x\/\.env$/);
  assert.match(sent[0], /要读本机文件/);

  const byToken = await call(`/v1/approvals/${rowId}/decide`, { method: "POST", body: JSON.stringify({ decision: "approved", by: "x" }) });
  assert.equal(byToken.status, 403);
  assert.equal(getApproval(store, rowId)!.status, "pending");

  const t0 = Date.now();
  const bySession = await call(`/v1/approvals/${rowId}/decide`, {
    auth: asSession(), method: "POST", body: JSON.stringify({ decision: "approved", by: "web" }),
  });
  assert.equal(bySession.status, 200, JSON.stringify(bySession.body));
  const r = await pending;
  assert.equal(r.decision, "approved");
  assert.equal(r.rowId, rowId);
  assert.ok(Date.now() - t0 < 2000, "不该等到超时");
  assert.equal(getApproval(store, rowId)!.status, "approved");
});
