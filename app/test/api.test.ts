/** REST API 的契约：鉴权、路由、返回体、沙盒文件边界。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { startApiServer } from "../src/api.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-api-"));
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  // 单测会合并线上 local.json，外部技能库和运行时目录都要指到临时目录
  runtimeDir: path.join(dir, "runtime"),
  exec: { dir: path.join(dir, "sandbox"), sharedSkillsDir: "" },
});
const store = new Store(path.join(dir, "test.db"));
const log = new Logger(null, true);
const token = "t".repeat(32);

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  store.insertMessage({
    platform: "feishu", external_chat_id: "c1", pool_kind: "private", msg_id: "m1",
    sender_id: "u1", sender_name: "小王", ts: Date.parse("2026-10-20T10:00:00+08:00"),
    text: "明天一起吃火锅", reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  fs.mkdirSync(path.join(dir, "media"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sandbox", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sandbox", "skills", "demo", "SKILL.md"), "# demo\n");
  fs.writeFileSync(path.join(dir, "media", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  server = await startApiServer({ cfg, store, log, token });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = async (p: string, init: RequestInit & { auth?: string | null } = {}) => {
  const { auth, ...rest } = init;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth ?? `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { ...rest, headers: { ...headers, ...(rest.headers as any) } });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
};

test("没有 token / token 不对：401", async () => {
  assert.equal((await call("/v1/pools", { auth: null })).status, 401);
  assert.equal((await call("/v1/pools", { auth: "Bearer wrong-wrong-wrong" })).status, 401);
});

test("健康检查不需要 token", async () => {
  const r = await call("/health", { auth: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, "ok");
});

test("静态只读看板不需要 token：/ 和 /ui/* 都返回正确类型", async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await page.text(), /Rabbit Bot 管理台/);

  const css = await fetch(`${base}/ui/style.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);

  const js = await fetch(`${base}/ui/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);

  // 路径穿越不能读到 web/ 之外的文件（编码后的斜杠不会被 URL 规范化掉）
  assert.equal((await call("/ui/..%2fpackage.json")).status, 404);
});

test("池：列表、读消息、搜索", async () => {
  const list = await call("/v1/pools");
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].alias, "p1");
  assert.equal(list.body.data[0].total, 1);

  const msgs = await call("/v1/pools/p1/messages?limit=5");
  assert.equal(msgs.status, 200);
  assert.match(JSON.stringify(msgs.body.data.messages), /火锅/);

  const found = await call("/v1/pools/p1/search?q=火锅");
  assert.equal(found.body.data.hits, 1);
  const tooShort = await call("/v1/pools/p1/search?q=火");
  assert.equal(tooShort.status, 400);
});

test("用户：列表、手动改名、回填历史消息", async () => {
  const before = await call("/v1/users");
  assert.equal(before.status, 200);
  const user = before.body.data.find((u: any) => u.identities.some((i: any) => i.platform_user_id === "u1"));
  assert.ok(user);
  assert.equal(user.identities[0].display_name, "小王");

  const patched = await call(`/v1/users/${user.user_id}`, {
    method: "PATCH",
    body: JSON.stringify({ display_name: "王小明", backfill: true }),
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.data.display_name, "王小明");
  assert.equal(patched.body.data.alias, "王小明");
  assert.equal(patched.body.data.backfilled, 1);

  const after = await call("/v1/users");
  const updated = after.body.data.find((u: any) => u.user_id === user.user_id);
  assert.equal(updated.display_name, "王小明");
  assert.equal(updated.identities[0].display_name, "王小明");

  const msgs = await call("/v1/pools/p1/messages?limit=5");
  assert.equal(msgs.body.data.messages[0].sender, "王小明");
  assert.equal(msgs.body.data.messages[0].sender_name, "王小明", "backfill 后历史消息原名也改了");

  assert.equal((await call(`/v1/users/${user.user_id}`, {
    method: "PATCH", body: JSON.stringify({ display_name: "  " }),
  })).status, 400);
  assert.equal((await call("/v1/users/u_nope", {
    method: "PATCH", body: JSON.stringify({ display_name: "x" }),
  })).status, 404);

  // 自动名后来变了，人工别名也不能被冲掉
  store.resolveUser("feishu", "u1", "小王");
  const kept = (await call("/v1/users")).body.data.find((u: any) => u.user_id === user.user_id);
  assert.equal(kept.alias, "王小明");
  assert.equal(kept.display_name, "小王");
});

test("计划：写、列、改状态", async () => {
  const add = await call("/v1/plans", {
    method: "POST",
    body: JSON.stringify({ title: "问他结果", kind: "once", when: "2030-01-01T10:00", pool: "p1" }),
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const id = add.body.data.id;

  const list = await call("/v1/plans");
  assert.ok(list.body.data.some((p: any) => p.id === id && p.title === "问他结果"));

  const done = await call(`/v1/plans/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, "done");

  const bad = await call("/v1/plans/99999", { method: "PATCH", body: JSON.stringify({ status: "done" }) });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /没有计划/);
});

test("记忆：写、查；scope 按池类型推导", async () => {
  const add = await call("/v1/memories", {
    method: "POST",
    body: JSON.stringify({ user: "u1", content: "他对花生过敏", pool: "p1" }),
  });
  assert.equal(add.status, 201);
  assert.equal(add.body.data.scope, "private");

  const found = await call("/v1/memories?user=u1&pool=p1");
  assert.equal(found.body.data.length, 1);
  assert.equal(found.body.data[0].content, "他对花生过敏");
});

test("记忆：PUT 改正文，DELETE 删除", async () => {
  const add = await call("/v1/memories", {
    method: "POST",
    body: JSON.stringify({ user: "u-edit", content: "旧正文", pool: "p1" }),
  });
  const id = add.body.data.id;
  const put = await call(`/v1/memories/${id}`, {
    method: "PUT",
    body: JSON.stringify({ user: "u-edit", content: "新正文" }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const found = await call("/v1/memories?user=u-edit&pool=p1");
  assert.equal(found.body.data[0].content, "新正文");

  const del = await call(`/v1/memories/${id}?user=u-edit`, { method: "DELETE" });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.data.deleted, true);
  const after = await call("/v1/memories?user=u-edit&pool=p1");
  assert.equal(after.body.data.length, 0);
});

test("人设与系统提示词：读默认、写运行时、读回", async () => {
  const persona = await call("/v1/persona");
  assert.equal(persona.status, 200);
  assert.equal(typeof persona.body.data.content, "string");

  const savedPersona = await call("/v1/persona", {
    method: "PUT",
    body: JSON.stringify({ content: "新的人设正文" }),
  });
  assert.equal(savedPersona.status, 200, JSON.stringify(savedPersona.body));
  assert.equal(savedPersona.body.data.source, "runtime");
  const readPersona = await call("/v1/persona");
  assert.equal(readPersona.body.data.content, "新的人设正文");
  assert.equal(fs.existsSync(path.join(cfg.runtimeDir, "persona.md")), true);

  const prompt = await call("/v1/prompts/system");
  assert.equal(prompt.status, 200);
  assert.ok(prompt.body.data.content.length > 0);

  const savedPrompt = await call("/v1/prompts/system", {
    method: "PUT",
    body: JSON.stringify({ content: "新的系统提示词" }),
  });
  assert.equal(savedPrompt.status, 200, JSON.stringify(savedPrompt.body));
  assert.equal(savedPrompt.body.data.source, "runtime");
  const readPrompt = await call("/v1/prompts/system");
  assert.equal(readPrompt.body.data.content, "新的系统提示词");
});

test("技能：列出设计文件和数据目录", async () => {
  const r = await call("/v1/skills");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, [{ name: "demo", description: "", skill: "skills/demo/SKILL.md", data: "skills/demo/data", has_data: false, readonly: false }]);
});

test("沙盒文件：写读、越界拒绝", async () => {
  const put = await call("/v1/sandbox/file?path=notes/todo.md", {
    method: "PUT",
    body: JSON.stringify({ content: "- 买菜" }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const got = await call("/v1/sandbox/file?path=notes/todo.md");
  assert.equal(got.body.data.content, "- 买菜");

  const listed = await call("/v1/sandbox/files?path=notes");
  assert.match(JSON.stringify(listed.body.data), /todo\.md/);

  const escape = await call("/v1/sandbox/file?path=../../etc/passwd", { method: "PUT", body: JSON.stringify({ content: "x" }) });
  assert.equal(escape.status, 400);
});

test("图片：列表与原始字节，越界拒绝", async () => {
  const list = await call("/v1/images?source=inbox");
  assert.equal(list.status, 200);

  const raw = await fetch(`${base}/v1/images/file?path=media/a.png`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("content-type"), "image/png");
  assert.equal((await raw.arrayBuffer()).byteLength, 4);

  const escape = await call("/v1/images/file?path=../test.db");
  assert.equal(escape.status, 400);
});

test("任务面板：6 个路由 + 鉴权与校验", async () => {
  const created = await call("/v1/tasks", {
    method: "POST",
    body: JSON.stringify({
      name: "纪要", goal: "整理会议纪要", work_dir: dir, dispatch: false,
      deliverable: "notes.md", constraints: "只读", acceptance: "有结论", files: ["a.txt"],
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  assert.equal(created.body.data.name, "#纪要");
  assert.equal(created.body.data.status, "pending_approval");
  assert.equal(created.body.data.goal, "整理会议纪要");
  assert.match(created.body.data.start_at_local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const got = await call(`/v1/tasks/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.id, id);

  const list = await call("/v1/tasks?status=pending_approval&limit=10");
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((t: any) => t.id === id));

  const note = await call(`/v1/tasks/${id}/note`, { method: "POST", body: JSON.stringify({ line: "开始处理" }) });
  assert.equal(note.status, 200);
  assert.match(note.body.data.note, /开始处理/);

  const status = await call(`/v1/tasks/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "running", result: "进行中" }),
  });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.status, "running");
  assert.equal(status.body.data.result, "进行中");

  const cancelled = await call(`/v1/tasks/${id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, "cancelled");

  // Bearer + 参数校验
  assert.equal((await call("/v1/tasks", { auth: null })).status, 401);
  assert.equal((await call("/v1/tasks", { method: "POST", body: JSON.stringify({ deliverable: "x" }) })).status, 400);
  assert.equal((await call("/v1/tasks", {
    method: "POST", body: JSON.stringify({ goal: "x", work_dir: dir, dispatch: false }),
  })).status, 400, "缺 name 要 400");
  assert.equal((await call("/v1/tasks", {
    method: "POST", body: JSON.stringify({ name: "  ", goal: "x", work_dir: dir, dispatch: false }),
  })).status, 400, "空白 name 要 400");
  assert.equal((await call(`/v1/tasks/${id}/note`, { method: "POST", body: JSON.stringify({ line: "  " }) })).status, 400);
  assert.equal((await call(`/v1/tasks/${id}/status`, { method: "POST", body: JSON.stringify({ status: "wat" }) })).status, 400);
  assert.equal((await call("/v1/tasks/999999")).status, 404);
  assert.equal((await call("/v1/tasks/abc")).status, 400);
});

test("未知路由 404，缺 token 时也不泄露路由", async () => {
  assert.equal((await call("/v1/nope")).status, 404);
  assert.equal((await call("/v1/nope", { auth: null })).status, 401);
  // Web 只读：原来的发消息写接口已经移除
  assert.equal((await call("/v1/pools/p1/messages", {
    method: "POST",
    body: JSON.stringify({ text: "只读看板不该能发消息" }),
  })).status, 404);
});
