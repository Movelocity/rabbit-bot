/** 记忆与计划：原生工具（remember / forget / plan_add / plan_done），以及 rb 只留运维。 */
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

test("remember：自动落到这一轮的池和人，不用模型填 user", async () => {
  const { store, pool, get } = setup();
  const r = await run(get("remember"), { content: "11-03 钥匙弄好了，楼下五金店打的" });
  assert.equal(r.details?.ok, true, JSON.stringify(r));
  const got = searchMemories(store, { user: store.lastUserId(pool!)!, pool: pool! });
  assert.equal(got.length, 1);
  assert.match(got[0].content, /五金店/);
});

test("remember：supersede 顶掉旧的，旧的那条查不到", async () => {
  const { store, pool, get } = setup();
  const a = await run(get("remember"), { content: "他想辞职" });
  const id = Number(/（#(\d+)）/.exec(a.text)?.[1]);
  assert.ok(id > 0, a.text);
  const b = await run(get("remember"), { content: "他不想辞了，想升职", supersede: id });
  assert.equal(b.details?.ok, true);
  const cur = searchMemories(store, { user: store.lastUserId(pool!)!, pool: pool! });
  assert.equal(cur.length, 1);
  assert.match(cur[0].content, /升职/);
});

test("remember：自由文本里的引号和箭头不会被 shell 吃掉", async () => {
  const { store, pool, get } = createAndSeed();
  const content = '他说"那个项目"→ 电商 AI Agent；别记错';
  const r = await run(get("remember"), { content, kind: "alias" });
  assert.equal(r.details?.ok, true);
  const got = searchMemories(store, { user: store.lastUserId(pool!)!, pool: pool!, all: true });
  assert.equal(got[0].content, content, "一个字符都不该变");
});

function createAndSeed() {
  return setup();
}

test("remember：坏时间格式当场报错，不静默写坏", async () => {
  const { get } = setup();
  const r = await run(get("remember"), { content: "x", from: "后天下午" });
  assert.equal(r.details?.ok, false);
  assert.match(String(r.text), /看不懂的时间/);
});

test("forget：只关掉，不写新的", async () => {
  const { store, pool, get } = setup();
  const a = await run(get("remember"), { content: "他这周在出差" });
  const id = Number(/（#(\d+)）/.exec(a.text)?.[1]);
  const r = await run(get("forget"), { id });
  assert.equal(r.details?.ok, true);
  const uid = store.lastUserId(pool!)!;
  assert.equal(searchMemories(store, { user: uid, pool: pool! }).length, 0);
  assert.equal(searchMemories(store, { user: uid, pool: pool!, all: true }).length, 1);
});

test("forget：关别人的记忆会被挡住", async () => {
  const { store, get } = setup();
  const a = await run(get("remember"), { content: "他这周在出差" });
  const id = Number(/（#(\d+)）/.exec(a.text)?.[1]);
  const r = await run(get("forget"), { id, user: "u_someone_else" });
  assert.equal(r.details?.ok, false);
  assert.match(String(r.text), /不是 u_someone_else 的记忆/);
});

test("plan_add / plan_done：一件事从记下到标完成", async () => {
  const { store, get } = setup();
  const a = await run(get("plan_add"), { title: "提醒他带钥匙", when: "2026-11-04T09:00:00+08:00" });
  assert.equal(a.details?.ok, true, JSON.stringify(a));
  const plans = store.listPlans("pending");
  assert.ok(plans.length >= 1, "计划要真的进库");
  const id = plans[0].id;
  const b = await run(get("plan_done"), { id });
  assert.equal(b.details?.ok, true);
});

test("没有对应池时明确报错，别写到一个空池里", async () => {
  const { get } = setup({ withUser: false });
  const r = await run(get("remember"), { content: "x" });
  assert.equal(r.details?.ok, false);
  assert.match(String(r.text), /没有对方的消息|没有对应的池/);
});

test("rb 不再接受业务写入，改成指向对应工具", async () => {
  const { get, calls } = setup();
  for (const [cmd, tool] of [["mem-add", "remember"], ["mem-close", "forget"], ["plan-add", "plan_add"], ["plan-update", "plan_done"]]) {
    const r = await run(get("rb"), { args: `${cmd} --user u1 --content x --pool p1` });
    assert.equal(r.details?.ok, false, `${cmd} 该被挡下`);
    assert.equal(r.details?.useTool, tool, `${cmd} 该指向 ${tool}`);
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
