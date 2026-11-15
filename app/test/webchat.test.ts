/** Web 登录与管理台统一：账号密码登录 + 网页直聊独立池收发 + 网页池免审。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { Hub } from "../src/core/hub.ts";
import { EmojiTable } from "../src/core/emoji.ts";
import { WebAdapter } from "../src/adapters/web.ts";
import { WebAuth, effectiveWebChat } from "../src/core/web-auth.ts";
import { reviewRequiredFor } from "../src/ops/send-review-settings.ts";
import { startApiServer } from "../src/api.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-webchat-"));
const oldPasswordEnv = process.env.RABBIT_BOT_WEB_PASSWORD;
delete process.env.RABBIT_BOT_WEB_PASSWORD;

const baseCfg = {
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: path.join(dir, "sandbox"), sharedSkillsDir: "" },
  llm: { provider: "deepseek", model: "deepseek-flash", models: [] },
  webChat: {
    enabled: true,
    username: "rabbit-bot",
    pool: "web-chat",
    title: "网页直聊",
    sessionDays: 30,
  },
} as const;

const cfg = loadConfig(baseCfg);
const store = new Store(path.join(dir, "test.db"));
const log = new Logger(null, true);
const token = "t".repeat(32);
const hub = new Hub(store, cfg, log, new EmojiTable());
hub.addAdapter(new WebAdapter());

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  server = await startApiServer({ cfg, store, log, token, hub });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (oldPasswordEnv === undefined) delete process.env.RABBIT_BOT_WEB_PASSWORD;
  else process.env.RABBIT_BOT_WEB_PASSWORD = oldPasswordEnv;
});

const call = async (
  p: string,
  init: RequestInit & { auth?: string | null } = {},
) => {
  const { auth, ...rest } = init;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth ?? `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, {
    ...rest,
    headers: { ...headers, ...(rest.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

test("公共状态：未设置密码时要求首次引导", async () => {
  const r = await call("/v1/webchat/status", { auth: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.enabled, true);
  assert.equal(r.body.data.username, "rabbit-bot");
  assert.equal(r.body.data.setup_required, true);
  assert.equal(r.body.data.authenticated, false);
});

test("首次引导：太短拒绝，设置成功后拿到会话 token", async () => {
  const short = await call("/v1/webchat/setup", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ password: "123" }),
  });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /至少/);

  const ok = await call("/v1/webchat/setup", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ password: "rabbit-2026" }),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.data.token);

  const again = await call("/v1/webchat/setup", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ password: "another-pass" }),
  });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /已经设置/);

  const st = await call("/v1/webchat/status", {
    auth: `Bearer ${ok.body.data.token}`,
  });
  assert.equal(st.body.data.setup_required, false);
  assert.equal(st.body.data.authenticated, true);
});

test("登录：密码错误 401，正确拿到 token；会话 token 和管理台共用", async () => {
  const bad = await call("/v1/webchat/login", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ username: "rabbit-bot", password: "wrong-pass" }),
  });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /用户名或密码/);

  const good = await call("/v1/webchat/login", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ username: "rabbit-bot", password: "rabbit-2026" }),
  });
  assert.equal(good.status, 200);
  const session = good.body.data.token as string;
  assert.ok(session);

  const meRes = await call("/v1/webchat/me", { auth: `Bearer ${session}` });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.username, "rabbit-bot");

  // 统一入口：账号密码登录后，管理台接口和网页直聊共用同一个会话 token
  const pools = await call("/v1/pools", { auth: `Bearer ${session}` });
  assert.equal(pools.status, 200);
  const webPool = pools.body.data.find((p: any) => p.pool_id === "web:web-chat");
  assert.ok(webPool, "会话列表应包含网页直聊池");
  assert.equal(webPool.platform, "web");
  assert.equal(webPool.title, "网页直聊");
  assert.equal((await call("/v1/tasks", { auth: `Bearer ${session}` })).status, 200);
  assert.equal((await call("/v1/send-review", { auth: `Bearer ${session}` })).status, 200);
});

test("统一认证别名 /v1/auth/*：状态、登录、me、退出", async () => {
  const st = await call("/v1/auth/status", { auth: null });
  assert.equal(st.status, 200);
  assert.equal(st.body.data.username, "rabbit-bot");
  assert.equal(st.body.data.setup_required, false);

  const loginRes = await call("/v1/auth/login", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ username: "rabbit-bot", password: "rabbit-2026" }),
  });
  assert.equal(loginRes.status, 200);
  const session = loginRes.body.data.token as string;
  const meRes = await call("/v1/auth/me", { auth: `Bearer ${session}` });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.username, "rabbit-bot");
  assert.equal(meRes.body.data.via, "session");
  assert.equal((await call("/v1/auth/logout", { auth: `Bearer ${session}`, method: "POST" })).status, 200);
  assert.equal((await call("/v1/auth/me", { auth: `Bearer ${session}` })).status, 401);
});

test("独立 /chat 入口已合并：GET /chat 302 回统一管理台", async () => {
  const res = await fetch(`${base}/chat`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/?tab=chat");
});

test("网页直聊发消息免审：即使按池策略要求审核也不进审批", async () => {
  const settings = { enabled: true, defaultReview: true, primaryPoolId: null as string | null, overrides: {} as Record<string, boolean> };
  assert.equal(reviewRequiredFor(settings, "web:web-chat"), false);
  assert.equal(reviewRequiredFor({ ...settings, overrides: { "web:web-chat": true } }, "web:web-chat"), false);
  assert.equal(reviewRequiredFor(settings, "feishu:g1"), true);
});

test("网页直聊：发送入独立 web 池，按 after_seq 增量读回", async () => {
  const loginRes = await call("/v1/webchat/login", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ username: "rabbit-bot", password: "rabbit-2026" }),
  });
  const session = loginRes.body.data.token as string;
  const auth = `Bearer ${session}`;

  const empty = await call("/v1/webchat/messages", { auth });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.messages, []);

  const sent = await call("/v1/webchat/send", {
    auth,
    method: "POST",
    body: JSON.stringify({ text: "你好，网页直聊" }),
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const firstSeq = sent.body.data.seq as number;
  assert.ok(firstSeq > 0);

  const listed = await call("/v1/webchat/messages", { auth });
  assert.equal(listed.body.data.messages.length, 1);
  const poolsAfter = await call("/v1/pools", { auth });
  const webPoolAfter = poolsAfter.body.data.find((p: any) => p.pool_id === "web:web-chat");
  assert.equal(webPoolAfter.title, "网页直聊", "有人发过消息后仍显示配置的标题");
  assert.equal(listed.body.data.messages[0].text, "你好，网页直聊");
  assert.equal(listed.body.data.messages[0].from_self, false);
  assert.equal(listed.body.data.messages[0].sender, "rabbit-bot");

  const pool = store.getPool(Store.poolIdFor("web", "web-chat"));
  assert.ok(pool, "网页池应自动建出来");
  assert.equal(pool!.platform, "web");
  assert.equal(pool!.kind, "private");

  // agent 通过 hub 回复：进同一个池，前端能看到
  // 真实链路里调度器唤醒时会先读走未读；这里手动推进游标，避免 send 的“发之前来了新消息”保护压住回复
  store.advanceCursor(pool!.pool_id, firstSeq);
  const reply = await hub.send(pool!.pool_id, "收到，我在。");
  assert.equal(reply.ok, true, reply.error);

  const all = await call("/v1/webchat/messages", { auth });
  assert.equal(all.body.data.messages.length, 2);
  assert.equal(all.body.data.messages[1].from_self, true);
  assert.equal(all.body.data.messages[1].text, "收到，我在。");

  const second = await call("/v1/webchat/send", {
    auth,
    method: "POST",
    body: JSON.stringify({ text: "第二条" }),
  });
  assert.equal(second.status, 201);

  const after = await call(`/v1/webchat/messages?after_seq=${second.body.data.seq - 1}`, { auth });
  assert.equal(after.body.data.messages.length, 1);
  assert.equal(after.body.data.messages[0].text, "第二条");

  // 空消息拒绝
  const blank = await call("/v1/webchat/send", {
    auth,
    method: "POST",
    body: JSON.stringify({ text: "   " }),
  });
  assert.equal(blank.status, 400);

  // API token 也能读网页池，便于部署自检
  const admin = await call("/v1/webchat/messages");
  assert.equal(admin.status, 200);
  assert.ok(admin.body.data.messages.length >= 3);
});

test("退出登录：会话 token 立即失效", async () => {
  const loginRes = await call("/v1/webchat/login", {
    auth: null,
    method: "POST",
    body: JSON.stringify({ username: "rabbit-bot", password: "rabbit-2026" }),
  });
  const session = loginRes.body.data.token as string;
  const out = await call("/v1/webchat/logout", { auth: `Bearer ${session}`, method: "POST" });
  assert.equal(out.status, 200);
  assert.equal((await call("/v1/webchat/me", { auth: `Bearer ${session}` })).status, 401);
});

test("配置里指定密码：不再走首次引导，setup 被拒绝", async () => {
  const cfg2 = loadConfig({
    ...baseCfg,
    dataDir: path.join(dir, "configured"),
    logDir: path.join(dir, "configured-logs"),
    webChat: { ...baseCfg.webChat, password: "from-config" },
  });
  const store2 = new Store(path.join(dir, "configured.db"));
  const auth = new WebAuth(store2, cfg2);
  assert.equal(auth.setupRequired(), false);
  assert.ok(auth.login("rabbit-bot", "from-config"));
  assert.equal(auth.login("rabbit-bot", "nope"), null);
  assert.throws(() => auth.setup("whatever-1"), /配置/);
  const ws = effectiveWebChat(cfg2);
  assert.equal(ws.username, "rabbit-bot");
  assert.equal(ws.pool, "web-chat");
  store2.close();
});
