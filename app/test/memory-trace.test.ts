import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { addMemory, searchMemories, traceMemory } from "../src/ops/memories.ts";

function say(store: Store, chat: string, text: string, opts: { user?: string; fromSelf?: boolean } = {}) {
  return store.insertMessage({
    platform: "feishu", external_chat_id: chat, pool_kind: "private",
    msg_id: `${chat}-${text}`, sender_id: opts.fromSelf ? "bot" : (opts.user ?? "u1"),
    sender_name: opts.fromSelf ? "我" : "他", ts: Date.now() + Math.random(), text,
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text", from_self: !!opts.fromSelf,
  })!;
}

function setup() {
  const store = new Store(":memory:");
  const a = say(store, "oc_a", "最近怎么样");
  const b = say(store, "oc_a", "我下个月要搬家");
  const c = say(store, "oc_a", "从北京搬去上海");
  const d = say(store, "oc_a", "房租贵了不少");
  const e = say(store, "oc_a", "先这样");
  const pool = a.pool_id;
  return { store, pool, msgs: [a, b, c, d, e] };
}

test("记记忆时带上来源 seq，search 能查到", () => {
  const { store, pool, msgs } = setup();
  const r = addMemory(store, {
    user: "u1", content: "他下个月从北京搬去上海", pool,
    source_seq: msgs[1].seq, source_seq_end: msgs[2].seq,
  });
  assert.deepEqual(r.source, { pool, from: msgs[1].seq, to: msgs[2].seq });

  const got = searchMemories(store, { user: "u1", pool });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].source, { pool, from: msgs[1].seq, to: msgs[2].seq });
});

test("trace 能看到来源消息和前后各几条，锚点标出来", () => {
  const { store, pool, msgs } = setup();
  const r = addMemory(store, {
    user: "u1", content: "他下个月从北京搬去上海", pool,
    source_seq: msgs[1].seq, source_seq_end: msgs[2].seq,
  });

  const t = traceMemory(store, { user: "u1", id: r.id, before: 1, after: 1 });
  assert.deepEqual(t.messages.map((m) => m.seq), [msgs[0].seq, msgs[1].seq, msgs[2].seq, msgs[3].seq]);
  assert.deepEqual(t.messages.filter((m) => m.anchor).map((m) => m.seq), [msgs[1].seq, msgs[2].seq]);
  assert.equal(t.messages[0].anchor, false);
  assert.equal(t.messages[0].text, "最近怎么样");
});

test("before/after 截断到池边界，不越界", () => {
  const { store, pool, msgs } = setup();
  const r = addMemory(store, {
    user: "u1", content: "他下个月从北京搬去上海", pool, source_seq: msgs[0].seq,
  });
  const t = traceMemory(store, { user: "u1", id: r.id, before: 10, after: 2 });
  assert.deepEqual(t.messages.map((m) => m.seq), [msgs[0].seq, msgs[1].seq, msgs[2].seq]);
});

test("seq 是全局的：不会把别的池的消息带进来", () => {
  const store = new Store(":memory:");
  const a = say(store, "oc_a", "池 A 第一句");
  const other = say(store, "oc_b", "池 B 中间一句");
  const b = say(store, "oc_a", "池 A 第二句");

  const r = addMemory(store, { user: "u1", content: "A 说了两句话", pool: a.pool_id, source_seq: a.seq, source_seq_end: b.seq });
  const t = traceMemory(store, { user: "u1", id: r.id, before: 0, after: 0 });
  assert.deepEqual(t.messages.map((m) => m.seq), [a.seq, b.seq]);
  assert.ok(!t.messages.some((m) => m.seq === other.seq), "中间夹着的池 B 消息不该出现");
});

test("老记忆没有来源：返回 null 和说明，不瞎猜", () => {
  const { store, pool } = setup();
  const r = addMemory(store, { user: "u1", content: "一条没有来源的老记忆", pool });
  const t = traceMemory(store, { user: "u1", id: r.id });
  assert.equal(t.source, null);
  assert.deepEqual(t.messages, []);
  assert.match(t.note ?? "", /没有来源消息索引/);
});

test("回溯只看 id 和来源，不看 user", () => {
  const { store, pool, msgs } = setup();
  const r = addMemory(store, { user: "u1", content: "x", pool, source_seq: msgs[0].seq });
  const t = traceMemory(store, { user: "u2", id: r.id, before: 0, after: 0 });
  assert.deepEqual(t.messages.map((m) => m.seq), [msgs[0].seq]);
});

test("来源定位只靠 pool + seq：不传 user 也能回溯", () => {
  const { store, pool, msgs } = setup();
  const r = addMemory(store, { user: "u1", content: "x", pool, source_seq: msgs[0].seq });
  const t = traceMemory(store, { id: r.id, before: 0, after: 0 });
  assert.equal(t.source?.pool_id, pool);
  assert.deepEqual(t.messages.map((m) => m.seq), [msgs[0].seq]);
});

test("回溯不存在的记忆直接报错", () => {
  const { store } = setup();
  assert.throws(() => traceMemory(store, { user: "u1", id: 424242 }), /没有 id=424242/);
});
