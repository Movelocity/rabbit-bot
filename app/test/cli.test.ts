/** CLI 的契约：JSON 输出、退出码、参数解析。这些是「别的 agent 能不能用」的前提。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run, parseArgs } from "../src/cli.ts";
import { Store } from "../src/core/db.ts";

const tmpDb = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-cli-"));
  const f = path.join(dir, "test.db");
  new Store(f).close();
  return f;
};

async function cap(args: string[]) {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const code = await run(args);
    return { code, out: logs.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("parseArgs：位置参数、--k v、--k=v、裸 flag", () => {
  assert.deepEqual(parseArgs(["pool", "read", "p1", "--limit", "5"]), { pos: ["pool", "read", "p1"], flags: { limit: "5" } });
  assert.deepEqual(parseArgs(["plan", "add", "--title=写周报", "--anchor", "L2"]), { pos: ["plan", "add"], flags: { title: "写周报", anchor: "L2" } });
  assert.deepEqual(parseArgs(["--content"]), { pos: [], flags: { content: true } });
});

test("rb --help 打印用法，退出码 0", async () => {
  const r = await cap(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /pool read/);
  assert.match(r.out, /输出约定/);
});

test("pool list：JSON 里有 ok 和池数组", async () => {
  const db = tmpDb();
  const s = new Store(db);
  s.insertMessage({
    platform: "feishu", external_chat_id: "c1", pool_kind: "private", msg_id: "m1",
    sender_id: "u1", sender_name: "小王", ts: Date.now(), text: "你好",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  s.close();
  const r = await cap(["pool", "list", "--db", db]);
  assert.equal(r.code, 0);
  const body = JSON.parse(r.out);
  assert.equal(body.ok, true);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].total, 1);
});

test("pool search：关键词太短会被拒，退出码 1", async () => {
  const db = tmpDb();
  const r = await cap(["pool", "search", "火", "--pool", "p1", "--db", db]);
  assert.equal(r.code, 1);
  const body = JSON.parse(r.out);
  assert.equal(body.ok, false);
  assert.match(body.error, /至少两个字/);
});

test("plan add → plan list：CLI 写的计划，agent 侧查得到", async () => {
  const db = tmpDb();
  const now = Date.parse("2026-10-27T20:00:00+08:00");
  const add = await cap(["plan", "add", "--title", "问他面试结果", "--kind", "once", "--when", "2026-10-27T22:00", "--why", "他说今天出结果", "--db", db, "--now", String(now)]);
  assert.equal(add.code, 0, add.out);
  const added = JSON.parse(add.out);
  assert.equal(added.ok, true);
  const list = await cap(["plan", "list", "--db", db]);
  const body = JSON.parse(list.out);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].title, "问他面试结果");
  // 时间已过：拒绝，且不是静默失败
  const bad = await cap(["plan", "add", "--title", "过期的", "--kind", "once", "--when", "2026-10-01T08:00", "--db", db, "--now", String(now)]);
  assert.equal(bad.code, 1);
});

test("plan update：改状态；不存在的 id 报错", async () => {
  const db = tmpDb();
  const s = new Store(db);
  const p = s.insertPlan({ title: "旧事", content: "", pool_id: null, schedule_kind: "none", schedule: null, expires_at: null } as any);
  s.close();
  const r = await cap(["plan", "update", String(p.id), "--status", "done", "--db", db]);
  assert.equal(JSON.parse(r.out).data.status, "done");
  const bad = await cap(["plan", "update", "99999", "--status", "done", "--db", db]);
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.out).error, /没有计划/);
});

test("mem add → mem search：scope 按池类型推导", async () => {
  const db = tmpDb();
  const s = new Store(db);
  s.insertMessage({
    platform: "feishu", external_chat_id: "dm1", pool_kind: "private", msg_id: "x1",
    sender_id: "u1", sender_name: "小王", ts: Date.now(), text: "我对花生过敏",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  s.close();
  const add = await cap(["mem", "add", "--user", "u1", "--content", "他对花生过敏", "--pool", "p1", "--db", db]);
  assert.equal(add.code, 0, add.out);
  assert.equal(JSON.parse(add.out).data.scope, "private");
  const found = await cap(["mem", "search", "--user", "u1", "--pool", "p1", "--db", db]);
  const items = JSON.parse(found.out).data;
  assert.equal(items.length, 1);
  assert.equal(items[0].content, "他对花生过敏");
});

test("不认识的命令：给出可用列表，不静默成功", async () => {
  const db = tmpDb();
  const r = await cap(["frobnicate", "--db", db]);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.out).error, /不认识的命令/);
});

test("--human 走人读格式，仍是退出码 0", async () => {
  const db = tmpDb();
  const s = new Store(db);
  s.insertMessage({
    platform: "feishu", external_chat_id: "c2", pool_kind: "private", msg_id: "m2",
    sender_id: "u1", sender_name: "小王", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  s.close();
  const r = await cap(["pool", "read", "p1", "--limit", "5", "--human", "--db", db]);
  assert.equal(r.code, 0);
  assert.match(r.out, /在吗/);
  assert.doesNotMatch(r.out, /"ok"/);
});
