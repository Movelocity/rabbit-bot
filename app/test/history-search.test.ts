/** 池与消息的查询契约（ops/pools）：CLI 已删，脚本/API 共用这一层。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { listPools, readPool, searchPool } from "../src/ops/pools.ts";

let seq = 0;
const msg = (text: string, sender = "主人") => ({
  platform: "feishu", external_chat_id: "oc_x", pool_kind: "private" as const,
  msg_id: `m_${++seq}`, sender_id: `ou_${sender}`, sender_name: sender,
  ts: Date.now() + seq, text, reply_to: null, mentions: [], is_mention_me: false,
  media_type: "text" as const, from_self: sender === "爱马士", attachment: null,
});

function setup(lines: string[]) {
  const store = new Store(":memory:");
  for (const l of lines) store.insertMessage(msg(l) as any);
  return store;
}

test("pool-list：别名、类型、条数", () => {
  const store = setup(["你好"]);
  const pools = listPools(store);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].alias, "p1");
  assert.equal(pools[0].kind, "private");
  assert.equal(pools[0].total, 1);
});

test("pool-search：按关键词命中历史消息", () => {
  const store = setup(["今天加班到十点", "明天还要上班", "火锅约不约", "又是加班"]);
  const r = searchPool(store, "加班", "p1");
  assert.equal(r.hits, 2);
  const text = JSON.stringify(r.messages);
  assert.match(text, /今天加班到十点/);
  assert.match(text, /又是加班/);
  assert.doesNotMatch(text, /火锅约不约/);
});

test("pool-search：没有命中是空数组，不是错误", () => {
  const store = setup(["今天加班"]);
  const r = searchPool(store, "火箭发射", "p1");
  assert.equal(r.hits, 0);
  assert.deepEqual(r.messages, []);
});

test("pool-search：关键词太短直接拒绝", () => {
  const store = setup(["随便一句"]);
  for (const kw of ["", "加", "  a  "]) {
    assert.throws(() => searchPool(store, kw, "p1"), /至少两个字/, `应拒绝 ${JSON.stringify(kw)}`);
  }
});

test("pool-search：_ 被当字面量而不是通配符", () => {
  const store = setup(["变量叫 a_b", "变量叫 axb"]);
  const r = searchPool(store, "a_b", "p1");
  assert.equal(r.hits, 1);
  assert.match(JSON.stringify(r.messages), /a_b/);
  assert.doesNotMatch(JSON.stringify(r.messages), /axb/);
});

test("pool-search：limit 夹到 1-50", () => {
  const store = setup(Array.from({ length: 40 }, (_, i) => `第${i}条加班记录`));
  assert.equal(searchPool(store, "加班", "p1", 999).hits, 40);   // 只有 40 条，全给
  assert.equal(searchPool(store, "加班", "p1", 0).hits, 1);
  assert.equal(searchPool(store, "加班", "p1", 999).truncated, false);
});

test("pool-search：未知池报错", () => {
  const store = setup(["x"]);
  assert.throws(() => searchPool(store, "加班", "p9"), /未知的池/);
});

test("pool-read：给出池规模与最早序号", () => {
  const store = setup(["第一条", "第二条", "第三条"]);
  const r = readPool(store, "p1", { limit: 5 });
  assert.equal(r.total, 3);
  assert.equal(r.oldest_seq, 1);
  assert.match(JSON.stringify(r.messages), /第三条/);
});

test("pool-read：带 beforeSeq 时只给更早的部分", () => {
  const store = setup(["第一条", "第二条", "第三条"]);
  const r = readPool(store, "p1", { limit: 5, beforeSeq: 3 });
  const text = JSON.stringify(r.messages);
  assert.match(text, /第一条/);
  assert.match(text, /第二条/);
  assert.doesNotMatch(text, /第三条/);
});

test("pool-read：limit 夹到 1-50", () => {
  const store = setup(Array.from({ length: 60 }, (_, i) => `第${i}条`));
  assert.equal(readPool(store, "p1", { limit: 999 }).messages.length, 50);
  assert.equal(readPool(store, "p1", { limit: 0 }).messages.length, 1);
});
