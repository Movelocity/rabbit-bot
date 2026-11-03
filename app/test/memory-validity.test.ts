import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { addMemory, searchMemories, parseTs } from "../src/ops/memories.ts";

function setup() {
  const store = new Store(":memory:");
  // 建池：靠一条消息
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_mem", pool_kind: "private", msg_id: "m1",
    sender_id: "u1", sender_name: "他", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0].pool_id;
  return { store, pool };
}

const DAY = 24 * 3600e3;

test("写进去就算「至今有效」，查得到", () => {
  const { store, pool } = setup();
  const r = addMemory(store, { user: "u1", content: "他想辞职", pool });
  const got = searchMemories(store, { user: "u1", pool });
  assert.equal(got.length, 1);
  assert.equal(got[0].id, r.id);
  assert.equal(got[0].to, null, "没有失效时间");
  assert.equal(got[0].replaced_by, null);
});

test("改口：--supersede 顶掉旧的，默认查不到旧的", () => {
  const { store, pool } = setup();
  const old = addMemory(store, { user: "u1", content: "他想辞职", pool });
  const now = addMemory(store, { user: "u1", content: "他不想辞职了，想升职", pool, supersede: old.id });

  const cur = searchMemories(store, { user: "u1", pool });
  assert.equal(cur.length, 1, "此刻有效的只该有一条");
  assert.equal(cur[0].id, now.id);

  const all = searchMemories(store, { user: "u1", pool, all: true });
  assert.equal(all.length, 2);
  const dead = all.find((m) => m.id === old.id)!;
  assert.ok(dead.to, "旧的该有失效时间");
  assert.equal(dead.replaced_by, now.id, "要知道被哪条顶掉");
});

test("问「以前是怎么说的」：按时间点查", () => {
  const { store, pool } = setup();
  const t0 = Date.parse("2026-10-01T12:00:00+08:00");
  const t1 = Date.parse("2026-11-01T12:00:00+08:00");
  const old = addMemory(store, { user: "u1", content: "他想辞职", pool, from: t0 });
  // 手动把旧的失效时刻定在 t1，新条目从 t1 起成立
  store.addMemory({
    user_id: "u1", kind: "fact", content: "他想升职", source_pool_id: pool, source_kind: "private",
    scope: "private", valid_from: t1,
  });
  store.supersedeMemory(old.id, 999, t1);

  const before = searchMemories(store, { user: "u1", pool, at: t0 + DAY });
  assert.deepEqual(before.map((m) => m.content), ["他想辞职"]);
  const after = searchMemories(store, { user: "u1", pool, at: t1 + DAY });
  assert.deepEqual(after.map((m) => m.content), ["他想升职"]);
});

test("--until 到期就自己失效，不用手动顶", () => {
  const { store, pool } = setup();
  const t0 = Date.parse("2026-11-01T00:00:00+08:00");
  addMemory(store, { user: "u1", content: "这周他在出差", pool, from: t0, until: t0 + 7 * DAY });
  assert.equal(searchMemories(store, { user: "u1", pool, at: t0 + DAY }).length, 1, "出差中");
  assert.equal(searchMemories(store, { user: "u1", pool, at: t0 + 8 * DAY }).length, 0, "回来了");
});

test("不许顶别人的记忆", () => {
  const { store, pool } = setup();
  const mine = addMemory(store, { user: "u1", content: "他想辞职", pool });
  assert.throws(
    () => addMemory(store, { user: "u2", content: "他不想辞职了", pool, supersede: mine.id }),
    /不是 u2 的记忆/,
  );
});

test("顶一条不存在的记忆直接报错，别静默写新条目", () => {
  const { store, pool } = setup();
  assert.throws(() => addMemory(store, { user: "u1", content: "x", pool, supersede: 424242 }), /没有 id=424242/);
  assert.equal(searchMemories(store, { user: "u1", pool }).length, 0, "失败的写入不该留下半条");
});

test("until 早于 from 报错", () => {
  const { store, pool } = setup();
  assert.throws(
    () => addMemory(store, { user: "u1", content: "x", pool, from: "2026-11-02", until: "2026-11-01" }),
    /until 必须晚于 from/,
  );
});

test("kind 只认 fact / plan / alias / topic", () => {
  const { store, pool } = setup();
  assert.doesNotThrow(() => addMemory(store, { user: "u1", content: "「那个项目」= 电商 Agent", pool, kind: "alias" }));
  assert.doesNotThrow(() => addMemory(store, { user: "u1", content: "他聊过的话题", pool, kind: "topic" }), "库里早就有 topic，别把老数据挡住");
  assert.throws(() => addMemory(store, { user: "u1", content: "x", pool, kind: "随便" }), /kind 只能是/);
});

test("时间格式只认 ISO 和毫秒时间戳", () => {
  assert.equal(parseTs("2026-11-03"), Date.parse("2026-11-03T00:00:00.000Z"));
  assert.equal(parseTs("1793707200000"), 1793707200000);
  assert.equal(parseTs(undefined), null);
  assert.throws(() => parseTs("后天下午"), /看不懂的时间/);
});
