/**
 * Matrix 适配器的翻译层：平台事件 → InboundMessage。
 * 不碰网络：把 fetch 换成一个记账的假实现，跑一遍 sync 与 send。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MatrixAdapter } from "../src/adapters/matrix.ts";

const SELF = "@xiaoyu:matrix.hollway.top";
const rooms = {};

function fakeFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; method: string; body: any }[] = [];
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", body });
    const out = handler(url, init) ?? {};
    const status = out.__status ?? 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(out), arrayBuffer: async () => out.__bytes ?? Buffer.alloc(0) } as any;
  };
  return calls;
}

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any;

/** 事件现在走串行队列（下载附件是异步的），断言前得把队列排空 */
const flush = (a: any) => (a as any).queue as Promise<void>;

test("Matrix：text 消息翻译成私聊池消息，发送人取 displayname", async () => {
  const calls = fakeFetch((url) => {
    if (url.includes("/profile/")) return { displayname: "测试用户" };
    if (url.includes("/sync")) return { next_batch: "s1", rooms: { join: {} } };
    return {};
  });
  const a = new MatrixAdapter(
    { homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state.json" },
    logger,
  );
  const got: any[] = [];
  // 跳过 primeSince 的网络往返：直接喂一次 handleSync
  (a as any).since = "s0";
  (a as any).sink = (m: any) => got.push(m);
  await (a as any).handleSync({
    rooms: {
      join: {
        "!room1:mx.test": {
          summary: { "m.joined_member_count": 2 },
          state: { events: [{ type: "m.room.name", content: { name: "小鲸 & 测试用户" } }] },
          timeline: {
            events: [
              {
                type: "m.room.message",
                event_id: "$e1",
                sender: "@weikang:mx.test",
                origin_server_ts: 1700000000000,
                content: { msgtype: "m.text", body: "在吗" },
              },
            ],
          },
        },
      },
    },
  });
  await flush(a);
  assert.equal(got.length, 1);
  assert.equal(got[0].platform, "matrix");
  assert.equal(got[0].external_chat_id, "!room1:mx.test");
  assert.equal(got[0].pool_kind, "private");
  assert.equal(got[0].pool_title, "小鲸 & 测试用户");
  assert.equal(got[0].sender_name, "测试用户");
  assert.equal(got[0].text, "在吗");
  assert.equal(got[0].from_self, false);
  assert.equal(got[0].is_mention_me, false);
  assert.ok(calls.some((c) => c.url.includes("/profile/")));
});

test("Matrix：自己的消息标 from_self，群里没被 @ 不算 mention", async () => {
  fakeFetch((url) => (url.includes("/profile/") ? { displayname: "小鲸" } : {}));
  const a = new MatrixAdapter(
    { homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state-2.json" },
    logger,
  );
  const got: any[] = [];
  (a as any).sink = (m: any) => got.push(m);
  await (a as any).handleSync({
    rooms: {
      join: {
        "!grp:mx.test": {
          summary: { "m.joined_member_count": 5 },
          timeline: {
            events: [
              { type: "m.room.message", event_id: "$e2", sender: SELF, origin_server_ts: 1, content: { msgtype: "m.text", body: "我说的话" } },
              { type: "m.room.message", event_id: "$e3", sender: "@other:mx.test", origin_server_ts: 2, content: { msgtype: "m.text", body: "别人说话" } },
              { type: "m.room.message", event_id: "$e4", sender: "@other:mx.test", origin_server_ts: 3, content: { msgtype: "m.text", body: "叫一下", "m.mentions": { user_ids: [SELF] } } },
            ],
          },
        },
      },
    },
  });
  await flush(a);
  assert.equal(got.length, 3);
  assert.equal(got[0].from_self, true);
  assert.equal(got[0].pool_kind, "group");
  assert.equal(got[1].is_mention_me, false);
  assert.equal(got[2].is_mention_me, true);
});

test("Matrix：发送走 PUT /send，txn 每次不同", async () => {
  const calls = fakeFetch(() => ({ event_id: "$sent" }));
  const a = new MatrixAdapter(
    { homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state-3.json" },
    logger,
  );
  const r1 = await a.sendText("!room1:mx.test", "第一条");
  const r2 = await a.sendText("!room1:mx.test", "第二条");
  assert.equal(r1.msgId, "$sent");
  assert.equal(r2.msgId, "$sent");
  const sends = calls.filter((c) => c.url.includes("/send/m.room.message/"));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].method, "PUT");
  assert.notEqual(sends[0].url, sends[1].url); // txn 不能重复
  assert.deepEqual(sends[0].body, { msgtype: "m.text", body: "第一条" });
});

test("Matrix：被邀请就自动进房，且同一个房间只 join 一次", async () => {
  const calls = fakeFetch((url) => (url.includes("/join") ? { room_id: "!r:mx.test" } : {}));
  const a = new MatrixAdapter(
    { homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state-4.json" },
    logger,
  );
  (a as any).sink = () => {};
  const invite = {
    type: "m.room.member",
    event_id: "$inv1",
    sender: "@weikang:mx.test",
    state_key: SELF,
    origin_server_ts: 1,
    content: { membership: "invite" },
  };
  await (a as any).handleSync({ rooms: { join: { "!r:mx.test": { timeline: { events: [invite] } } } } });
  await (a as any).handleSync({ rooms: { join: { "!r:mx.test": { timeline: { events: [invite] } } } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.filter((c) => /\/join$/.test(c.url)).length, 1); // 注意 /joined_members 也含 "/join"
});

test("Matrix：同一条事件重放两次只入池一次", async () => {
  fakeFetch(() => ({}));
  const a = new MatrixAdapter(
    { homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state-5.json" },
    logger,
  );
  const got: any[] = [];
  (a as any).sink = (m: any) => got.push(m);
  const ev = { type: "m.room.message", event_id: "$dup", sender: "@weikang:mx.test", origin_server_ts: 1, content: { msgtype: "m.text", body: "重复" } };
  const sync = { rooms: { join: { "!r:mx.test": { summary: { "m.joined_member_count": 2 }, timeline: { events: [ev] } } } } };
  await (a as any).handleSync(sync);
  await (a as any).handleSync(sync);
  await flush(a);
  assert.equal(got.length, 1);
});

test("Matrix：图片消息下载落盘，长这样喂给模型", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-img-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const calls = fakeFetch((url) => {
    if (url.includes("/media/download/") || url.includes("/_matrix/media/")) return { __bytes: png };
    if (url.includes("/profile/")) return { displayname: "测试用户" };
    return {};
  });
  const a = new MatrixAdapter(
    {
      homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state-6.json",
      media: { dir, maxEdge: 1600, maxBytes: 2_000_000 },
    },
    logger,
  );
  const got: any[] = [];
  (a as any).sink = (m: any) => got.push(m);
  await (a as any).handleSync({
    rooms: {
      join: {
        "!room1:mx.test": {
          summary: { "m.joined_member_count": 2 },
          timeline: {
            events: [{
              type: "m.room.message", event_id: "$img1", sender: "@weikang:mx.test", origin_server_ts: 10,
              content: { msgtype: "m.image", body: "猫.png", url: "mxc://mx.test/abc123", info: { mimetype: "image/png" } },
            }],
          },
        },
      },
    },
  });
  await flush(a);
  assert.equal(got.length, 1);
  assert.equal(got[0].media_type, "image");
  assert.equal(got[0].text, "[图片：猫.png]");
  assert.ok(got[0].attachment?.path, "图片应该落盘");
  assert.ok(fs.existsSync(got[0].attachment.path));
  assert.ok(calls.some((c) => c.url.includes("/media/download/mx.test/abc123")));
});

test("Matrix：文件消息存进沙箱 files/，正文带上它的路径", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-file-"));
  const filesDir = path.join(dir, "sandbox", "files");
  const calls = fakeFetch((url) => {
    if (url.includes("/media/download/") || url.includes("/_matrix/media/")) return { __bytes: Buffer.from("hello 报告") };
    if (url.includes("/profile/")) return { displayname: "测试用户" };
    return {};
  });
  const a = new MatrixAdapter(
    { homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state-7.json", filesDir },
    logger,
  );
  const got: any[] = [];
  (a as any).sink = (m: any) => got.push(m);
  await (a as any).handleSync({
    rooms: {
      join: {
        "!room1:mx.test": {
          summary: { "m.joined_member_count": 2 },
          timeline: {
            events: [{
              type: "m.room.message", event_id: "$file1", sender: "@weikang:mx.test", origin_server_ts: 11,
              content: { msgtype: "m.file", body: "报告.pdf", url: "mxc://mx.test/doc456", info: { mimetype: "application/pdf" } },
            }],
          },
        },
      },
    },
  });
  await flush(a);
  assert.equal(got.length, 1);
  assert.equal(got[0].media_type, "file");
  assert.match(got[0].text, /^\[文件：报告\.pdf\]（已存到 files\/file1-报告\.pdf）$/);
  const saved = path.join(filesDir, "file1-报告.pdf");
  assert.ok(fs.existsSync(saved), `应该落到 ${saved}`);
  assert.equal(fs.readFileSync(saved, "utf8"), "hello 报告");
  assert.equal(got[0].attachment?.mime, "application/pdf");
  assert.ok(calls.some((c) => c.url.includes("/media/download/mx.test/doc456")));
});

test("Matrix：下载失败也不算崩，文字里标出来", async () => {
  fakeFetch((url) => {
    if (url.includes("/media/download/")) return { __status: 404, errcode: "M_NOT_FOUND" };
    if (url.includes("/profile/")) return { displayname: "测试用户" };
    return {};
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-fail-"));
  const a = new MatrixAdapter(
    {
      homeserver: "https://mx.test", userId: SELF, accessToken: "t", stateFile: "/tmp/mx-test-state-8.json",
      media: { dir, maxEdge: 1600, maxBytes: 2_000_000 }, filesDir: path.join(dir, "files"),
    },
    logger,
  );
  const got: any[] = [];
  (a as any).sink = (m: any) => got.push(m);
  await (a as any).handleSync({
    rooms: {
      join: {
        "!room1:mx.test": {
          summary: { "m.joined_member_count": 2 },
          timeline: {
            events: [{
              type: "m.room.message", event_id: "$img2", sender: "@weikang:mx.test", origin_server_ts: 12,
              content: { msgtype: "m.image", body: "挂了.png", url: "mxc://mx.test/nope" },
            }],
          },
        },
      },
    },
  });
  await flush(a);
  assert.equal(got.length, 1);
  assert.equal(got[0].attachment, null);
  assert.equal(got[0].text, "[图片：挂了.png]（没下载下来）");
});
