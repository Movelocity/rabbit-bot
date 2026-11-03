import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { searchPool } from "../src/ops/pools.ts";

const MIN = 60e3;

function setup() {
  const store = new Store(":memory:");
  const t0 = Date.parse("2026-11-03T20:00:00+08:00");
  return { store, t0 };
}

// ---------- 自省窗口：按时间跨度取，不是死数 10 条 ----------

test("话很密的时候，自省要看到 90 分钟前的原话，而不是只有最近 10 条", () => {
  const { store, t0 } = setup();
  // 19:05 他答过一句关键事实
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_r", pool_kind: "private", msg_id: "k0",
    sender_id: "u1", sender_name: "他", ts: t0 - 55 * MIN, text: "弄好了，楼下就有打钥匙的五金店",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  // 之后她自己连着说了 30 句（话密）
  for (let i = 1; i <= 30; i++) {
    store.insertMessage({
      platform: "feishu", external_chat_id: "oc_r", pool_kind: "private", msg_id: `m${i}`,
      sender_id: "me", sender_name: "小鲸", from_self: true, ts: t0 - 40 * MIN + i * MIN, text: `第 ${i} 句`,
      reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  const pool = store.listPools()[0].pool_id;

  // limit 现在只是下限，不是上限：只给 10 条会把 55 分钟前那句挤掉
  const now = store.messagesForReflection(pool, 12, { sinceMs: t0 - 90 * MIN, cap: 40 });
  assert.ok(now.length >= 12, `时间窗口该给出更多，实际 ${now.length}`);
  assert.ok(now.some((r) => r.text.includes("五金店")), "90 分钟内的事实必须看得到");
});

test("冷清的池：时间窗口里没几条，就往前补到下限", () => {
  const { store, t0 } = setup();
  for (let i = 0; i < 8; i++) {
    store.insertMessage({
      platform: "feishu", external_chat_id: "oc_q", pool_kind: "private", msg_id: `q${i}`,
      sender_id: i % 2 ? "me" : "u1", sender_name: i % 2 ? "小鲸" : "他", ts: t0 - (30 - i) * 60 * MIN,
      text: `旧消息 ${i}`, reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  const pool = store.listPools()[0].pool_id;
  const rows = store.messagesForReflection(pool, 12, { sinceMs: t0 - 90 * MIN, cap: 40 });
  assert.equal(rows.length, 8, "90 分钟内一条都没有时也要给到已有历史");
  assert.ok(rows[0].ts < rows[rows.length - 1].ts, "按时间正序，读起来才对");
});

// ---------- 搜索：别让自己的催问把答案挤掉 ----------

function seedKeys(store: Store, t0: number) {
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_s", pool_kind: "private", msg_id: "s0",
    sender_id: "u1", sender_name: "他", ts: t0 - 60 * MIN, text: "弄好了，楼下就有打钥匙的五金店",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  for (let i = 1; i <= 6; i++) {
    store.insertMessage({
      platform: "feishu", external_chat_id: "oc_s", pool_kind: "private", msg_id: `s${i}`,
      sender_id: "me", sender_name: "小鲸", from_self: true, ts: t0 - (30 - i) * MIN, text: `钥匙到底弄好了没 ${i}`,
      reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
    });
  }
  return store.listPools()[0].pool_id;
}

test("搜「钥匙」默认会被自己的催问塞满——所以要明说被截断了", () => {
  const { store, t0 } = setup();
  const pool = seedKeys(store, t0);
  const r = searchPool(store, "钥匙", pool, 5);
  assert.equal(r.hits, 5);
  assert.equal(r.truncated, true);
  assert.match(String(r.hint), /only-other/, "要告诉她还能只看他说的");
  assert.ok(r.messages.every((m) => m.from_self), "最近 5 条全是她自己催的");
});

test("--only-other：只看他说的，答案就在里面", () => {
  const { store, t0 } = setup();
  const pool = seedKeys(store, t0);
  const r = searchPool(store, "钥匙", pool, 20, "other");
  assert.equal(r.hits, 1);
  assert.equal(r.only, "other");
  assert.match(r.messages[0].text, /五金店/);
});

test("没截断时不吓唬人", () => {
  const { store, t0 } = setup();
  const pool = seedKeys(store, t0);
  const r = searchPool(store, "钥匙", pool, 50, "other");
  assert.equal(r.truncated, false);
  assert.equal(r.hint, undefined);
});
