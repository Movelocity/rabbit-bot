/** 记忆与计划：二级入口工具（memory / plan），以及 rb 只留运维。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { searchMemories } from "../src/ops/memories.ts";

function setup(opts: { withUser?: boolean } = {}) {
  const cfg = loadConfig();
  const store = new Store(":memory:");
  if (opts.withUser !== false) {
    store.insertMessage({
      platform: "feishu", external_chat_id: "oc_t", pool_kind: "private", msg_id: "m1",
      sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "在吗",
      reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  const pool = store.listPools()[0]?.pool_id ?? null;
  const calls: string[][] = [];
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(),
    primaryPool: () => pool,
    // rb 只该被运维命令用到；业务命令走不到这里
    rbExec: async (argv: string[]) => { calls.push(argv); return { ok: true, code: 0, output: "{}" }; },
  }) as any[];
  const get = (n: string) => tools.find((t) => t.name === n)!;
  return { store, pool, tools, get, calls };
}

const run = async (tool: any, params: any) => {
  const r = await tool.execute("id", params);
  // 工具的 content 是分段数组（可能带图片），测试里只要文字
  const raw = (r as any).content;
  const text = Array.isArray(raw)
    ? raw.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
    : String(raw ?? "");
  return { ...r, text };
};

test("memory add：自动落到这一轮的池和人，不用模型填 user", async () => {
  const { store, pool, get } = setup();
  const r = await run(get("memory"), { action: "add", content: "11-03 钥匙弄好了，楼下五金店打的" });
  assert.equal(r.details?.ok, true, JSON.stringify(r));
  const got = searchMemories(store, { user: store.lastUserId(pool!)!, pool: pool! });
  assert.equal(got.length, 1);
  assert.match(got[0].content, /五金店/);
});

test("memory add：supersede 顶掉旧的，旧的那条查不到", async () => {
  const { store, pool, get } = setup();
  const a = await run(get("memory"), { action: "add", content: "他想辞职" });
  const id = Number(/（#(\d+)）/.exec(a.text)?.[1]);
  assert.ok(id > 0, a.text);
  const b = await run(get("memory"), { action: "add", content: "他不想辞了，想升职", supersede: id });
  assert.equal(b.details?.ok, true);
  const cur = searchMemories(store, { user: store.lastUserId(pool!)!, pool: pool! });
  assert.equal(cur.length, 1);
  assert.match(cur[0].content, /升职/);
});

test("memory add：自由文本里的引号和箭头不会被 shell 吃掉", async () => {
  const { store, pool, get } = createAndSeed();
  const content = '他说"那个项目"→ 电商 AI Agent；别记错';
  const r = await run(get("memory"), { action: "add", content, kind: "alias" });
  assert.equal(r.details?.ok, true);
  const got = searchMemories(store, { user: store.lastUserId(pool!)!, pool: pool!, all: true });
  assert.equal(got[0].content, content, "一个字符都不该变");
});

function createAndSeed() {
  return setup();
}

test("memory add：坏时间格式当场报错，不静默写坏", async () => {
  const { get } = setup();
  const r = await run(get("memory"), { action: "add", content: "x", from: "后天下午" });
  assert.equal(r.details?.ok, false);
  assert.match(String(r.text), /看不懂的时间/);
});

test("memory expire：只关掉，不写新的", async () => {
  const { store, pool, get } = setup();
  const a = await run(get("memory"), { action: "add", content: "他这周在出差" });
  const id = Number(/（#(\d+)）/.exec(a.text)?.[1]);
  const r = await run(get("memory"), { action: "expire", id });
  assert.equal(r.details?.ok, true);
  const uid = store.lastUserId(pool!)!;
  assert.equal(searchMemories(store, { user: uid, pool: pool! }).length, 0);
  assert.equal(searchMemories(store, { user: uid, pool: pool!, all: true }).length, 1);
});

test("memory expire：关别人的记忆会被挡住", async () => {
  const { store, get } = setup();
  const a = await run(get("memory"), { action: "add", content: "他这周在出差" });
  const id = Number(/（#(\d+)）/.exec(a.text)?.[1]);
  const r = await run(get("memory"), { action: "expire", id, user: "u_someone_else" });
  assert.equal(r.details?.ok, false);
  assert.match(String(r.text), /不是 u_someone_else 的记忆/);
});

test("plan add / plan done：一件事从记下到标完成", async () => {
  const { store, get } = setup();
  const a = await run(get("plan"), { action: "add", title: "提醒他带钥匙", when: "2026-11-04T09:00:00+08:00" });
  assert.equal(a.details?.ok, true, JSON.stringify(a));
  const plans = store.listPlans("pending");
  assert.ok(plans.length >= 1, "计划要真的进库");
  const id = plans[0].id;
  const b = await run(get("plan"), { action: "done", id });
  assert.equal(b.details?.ok, true);
});

test("没有对应池时明确报错，别写到一个空池里", async () => {
  const { get } = setup({ withUser: false });
  const r = await run(get("memory"), { action: "add", content: "x" });
  assert.equal(r.details?.ok, false);
  assert.match(String(r.text), /没有对方的消息|没有对应的池/);
});

test("rb 不再接受业务写入，改成指向对应工具", async () => {
  const { get, calls } = setup();
  for (const [cmd, tool] of [["mem-add", "memory"], ["mem-close", "memory"], ["plan-add", "plan"], ["plan-update", "plan"]]) {
    const r = await run(get("rb"), { args: `${cmd} --user u1 --content x --pool p1` });
    assert.equal(r.details?.ok, false, `${cmd} 该被挡下`);
    assert.match(String(r.details?.useTool), new RegExp(tool), `${cmd} 该指向 ${tool}`);
  }
  assert.deepEqual(calls, [], "被挡下的命令不该真的进沙盒");
});

test("rb 的运维查询照旧能跑", async () => {
  const { get, calls } = setup();
  const r = await run(get("rb"), { args: "pool-search 钥匙 --pool p1 --only-other" });
  assert.equal(r.details?.ok, true);
  assert.deepEqual(calls[0], ["pool-search", "钥匙", "--pool", "p1", "--only-other"]);
});

// ---------- 文件工具：对齐 hermes 的 read_file / write_file ----------

function setupFs() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-fs-"));
  const base = loadConfig();
  const cfg = { ...base, dataDir, sandbox: { ...base.sandbox, dir: path.join(dataDir, "sandbox") } };
  fs.mkdirSync(cfg.sandbox.dir, { recursive: true });
  const store = new Store(":memory:");
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_fs", pool_kind: "private", msg_id: "f1",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0].pool_id;
  const tools = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), primaryPool: () => pool }) as any[];
  const get = (n: string) => tools.find((t) => t.name === n)!;
  const run = async (n: string, params: any) => {
    const r = await get(n).execute("id", params);
    const raw = (r as any).content;
    const text = Array.isArray(raw) ? raw.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("") : String(raw ?? "");
    return { ...r, text };
  };
  return { cfg, dataDir, run };
}

test("write_file → read_file：中文和空格路径都原样", async () => {
  const { dataDir, run } = setupFs();
  const w = await run("write_file", { path: "topics/生活 杂记.md", content: "今天吃了米饭" });
  assert.equal(w.details?.ok, true, w.text);
  const r = await run("read_file", { path: "topics/生活 杂记.md" });
  assert.equal(r.details?.ok, true, r.text);
  assert.equal(r.text, "今天吃了米饭");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("read_file：文件不存在就报错，不返回空字符串", async () => {
  const { dataDir, run } = setupFs();
  const r = await run("read_file", { path: "没有这个.md" });
  assert.equal(r.details?.ok, false);
  assert.ok(r.text.length > 0, "要有错误说明");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("write_file：不许跳出沙盒", async () => {
  const { dataDir, run } = setupFs();
  const r = await run("write_file", { path: "../../escape.md", content: "x" });
  assert.equal(r.details?.ok, false, "越界路径该被挡住");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("rb sb 也被挡了，指向文件工具", async () => {
  const { get } = setup();
  const r: any = await get("rb").execute("id", { args: "sb read topics/INDEX.md" });
  assert.equal(r.details?.ok, false);
  assert.match(String(r.details?.useTool), /read_file/);
});

// ---------- 二级入口：action 的边界 ----------

test("memory：action 写错就把可选动作列出来，不假装成功", async () => {
  const { get } = setup();
  const r: any = await get("memory").execute("id", { action: "记一下" });
  assert.equal(r.details?.ok, false);
  const text = r.content.map((c: any) => c.text ?? "").join("");
  assert.match(text, /recent[\s\S]*search[\s\S]*add[\s\S]*expire[\s\S]*update/, "该把六个动作列全");
});

test("memory：add 缺 content 直接说缺什么", async () => {
  const { get } = setup();
  const r: any = await get("memory").execute("id", { action: "add" });
  assert.equal(r.details?.ok, false);
  assert.match(r.content.map((c: any) => c.text ?? "").join(""), /要 content/);
});

test("memory：update 订正正文，时间线不动", async () => {
  const { store, pool, get } = setup();
  const a: any = await get("memory").execute("id", { action: "add", content: "钥匙在楼下打的" });
  const id = Number(/（#(\d+)）/.exec(a.content.map((c: any) => c.text ?? "").join(""))?.[1]);
  const b: any = await get("memory").execute("id", { action: "update", id, content: "钥匙在楼下五金店打的，20 块" });
  assert.equal(b.details?.ok, true);
  const got = searchMemories(store, { user: store.lastUserId(pool!)!, pool: pool! });
  assert.equal(got.length, 1, "改内容不该多出一条");
  assert.match(got[0].content, /20 块/);
});

test("memory：search 能按关键词翻，recent 给最近的", async () => {
  const { get } = setup();
  await get("memory").execute("id", { action: "add", content: "他周日约人吃潮汕火锅" });
  await get("memory").execute("id", { action: "add", content: "他在用 Cursor 会员" });
  const hit: any = await get("memory").execute("id", { action: "search", q: "火锅" });
  const text = hit.content.map((c: any) => c.text ?? "").join("");
  assert.match(text, /潮汕/);
  assert.doesNotMatch(text, /Cursor/);
  const recent: any = await get("memory").execute("id", { action: "recent", limit: 5 });
  assert.equal(recent.details?.count, 2);
});

test("plan：list 给得出刚加的，help 列出四个动作", async () => {
  const { get } = setup();
  await get("plan").execute("id", { action: "add", title: "提醒他开会", when: "2026-11-04T09:00:00+08:00" });
  const l: any = await get("plan").execute("id", { action: "list" });
  assert.match(l.content.map((c: any) => c.text ?? "").join(""), /提醒他开会/);
  const h: any = await get("plan").execute("id", { action: "help" });
  assert.match(h.content.map((c: any) => c.text ?? "").join(""), /add[\s\S]*done[\s\S]*list/);
});

test("terminal：名字换了，描述里说清列目录也走它", async () => {
  const { tools } = setup();
  const t = tools.find((x: any) => x.name === "terminal");
  assert.ok(t, "工具名该是 terminal");
  assert.match(t.description, /列目录/);
  assert.ok(!tools.some((x: any) => x.name === "run_shell"), "旧名字该没了");
});

// ---------- chat：说话与翻记录收成一个入口 ----------

test("chat：action 写错就把六个动作列全", async () => {
  const { get } = setup();
  const r: any = await get("chat").execute("id", { action: "说" });
  assert.equal(r.details?.ok, false);
  const text = r.content.map((c: any) => c.text ?? "").join("");
  assert.match(text, /send[\s\S]*skip[\s\S]*view[\s\S]*list[\s\S]*search/, "六个动作该列全");
});

test("chat：skip 没给理由不算数", async () => {
  const { get } = setup();
  const r: any = await get("chat").execute("id", { action: "skip" });
  assert.equal(r.details?.ok, false);
  assert.match(r.content.map((c: any) => c.text ?? "").join(""), /要 reason/);
});

test("chat：skip 把理由交给 markSilent", async () => {
  const cfg = loadConfig();
  const store = new Store(":memory:");
  let silent: string | null = null;
  const tools = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), markSilent: (r) => { silent = r; } }) as any[];
  const chat = tools.find((t) => t.name === "chat");
  await chat.execute("id", { action: "skip", reason: "他只是发了个表情" });
  assert.equal(silent, "他只是发了个表情");
});

test("chat：list 列出所有池", async () => {
  const { get } = setup();
  const r: any = await get("chat").execute("id", { action: "list" });
  assert.equal(r.details?.ok, true);
  assert.match(r.content.map((c: any) => c.text ?? "").join(""), /私聊/);
});

test("chat：search 给了 q 就翻原话，不给 q 就读最近", async () => {
  const { store, pool, get } = setup();
  await store.insertMessage({
    platform: "feishu", external_chat_id: "oc_t", pool_kind: "private", msg_id: "m2",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "钥匙在楼下五金店打的",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const hit: any = await get("chat").execute("id", { action: "search", q: "五金店", pool });
  assert.match(hit.content.map((c: any) => c.text ?? "").join(""), /五金店/);
  const read: any = await get("chat").execute("id", { action: "search", pool });
  assert.match(read.content.map((c: any) => c.text ?? "").join(""), /钥匙/);
});

test("chat：没搜到就说没搜到，别沉默", async () => {
  const { get } = setup();
  const r: any = await get("chat").execute("id", { action: "search", q: "量子力学" });
  assert.equal(r.details?.hits, 0);
  assert.match(r.content.map((c: any) => c.text ?? "").join(""), /没搜到/);
});
