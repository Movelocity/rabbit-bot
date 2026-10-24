import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

let seq = 0;
const msg = (text: string, sender = "主人") => ({
  platform: "feishu", external_chat_id: "oc_x", pool_kind: "private" as const,
  msg_id: `m_${++seq}`, sender_id: `ou_${sender}`, sender_name: sender,
  ts: Date.now() + seq, text, reply_to: null, mentions: [], is_mention_me: false,
  media_type: "text" as const, from_self: sender === "爱马士", attachment: null,
});

function setup(lines: string[]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-hist-"));
  const cfg = { ...loadConfig(), dataDir };
  const store = new Store(":memory:");
  for (const l of lines) store.insertMessage(msg(l) as any);
  const tools = createTools({ store, hub: {} as any, cfg, now: () => Date.now() }) as any[];
  return {
    store,
    search: tools.find((t) => t.name === "search_messages"),
    read: tools.find((t) => t.name === "read_pool"),
  };
}

test("search_messages：按关键词命中历史消息", async () => {
  const { search } = setup(["今天加班到十点", "明天还要上班", "火锅约不约", "又是加班"]);
  const r = await search.execute("c1", { pool: "p1", keyword: "加班" });
  const text = r.content[0].text as string;
  assert.match(text, /命中 2 条/);
  assert.match(text, /今天加班到十点/);
  assert.match(text, /又是加班/);
  assert.doesNotMatch(text, /火锅约不约/);
  assert.equal(r.details.hits, 2);
});

test("search_messages：没有命中时说清楚，不报错", async () => {
  const { search } = setup(["今天加班"]); 
  const r = await search.execute("c1", { pool: "p1", keyword: "火箭发射" });
  assert.match(r.content[0].text as string, /没找到/);
  assert.equal(r.details.hits, 0);
});

test("search_messages：关键词太短直接拦", async () => {
  const { search } = setup(["随便一句"]);
  for (const kw of ["", "加", "  a  "]) {
    const r = await search.execute("c1", { pool: "p1", keyword: kw });
    assert.match(r.content[0].text as string, /至少两个字/, `应拒绝 ${JSON.stringify(kw)}`);
  }
});

test("search_messages：_ 被当字面量而不是通配符", async () => {
  const { search } = setup(["变量叫 a_b", "变量叫 axb"]);
  const r = await search.execute("c1", { pool: "p1", keyword: "a_b" });
  const text = r.content[0].text as string;
  assert.match(text, /a_b/);
  assert.doesNotMatch(text, /axb/);
  assert.equal(r.details.hits, 1);
});

test("search_messages：limit 越界夹到 1-30", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `第${i}条加班记录`);
  const { search } = setup(lines);
  const r = await search.execute("c1", { pool: "p1", keyword: "加班", limit: 999 });
  assert.equal(r.details.hits, 30);
  assert.match(r.content[0].text as string, /可能还有更早的/);
});

test("search_messages：未知池报错不抛", async () => {
  const { search } = setup(["x"]);
  const r = await search.execute("c1", { pool: "p9", keyword: "加班" });
  assert.match(r.content[0].text as string, /未知的池/);
});

test("read_pool：给出池规模与最早序号，提示往前翻", async () => {
  const { read } = setup(["第一条", "第二条", "第三条"]);
  const r = await read.execute("c1", { pool: "p1" });
  const text = r.content[0].text as string;
  assert.match(text, /本池共 3 条/);
  assert.match(text, /最早 #1/);
  assert.match(text, /before_seq/);
  assert.match(text, /第三条/);
  assert.equal(r.details.total, 3);
});

test("read_pool：带 before_seq 时只给更早的部分", async () => {
  const { read } = setup(["第一条", "第二条", "第三条"]);
  const r = await read.execute("c1", { pool: "p1", before_seq: 3, limit: 5 });
  const text = r.content[0].text as string;
  assert.match(text, /第一条/);
  assert.match(text, /第二条/);
  assert.doesNotMatch(text, /第三条/);
});
