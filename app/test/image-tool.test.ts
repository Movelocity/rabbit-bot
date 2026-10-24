import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { saveImage } from "../src/core/media.ts";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-tool-"));
  const cfg = { ...loadConfig(), dataDir };
  const store = new Store(":memory:");
  const hub = {} as any; // view_image / list_images 不用 hub
  const tools = createTools({ store, hub, cfg, now: () => Date.now() });
  const view = (tools as any[]).find((t) => t.name === "view_image");
  const list = (tools as any[]).find((t) => t.name === "list_images");
  return { cfg, tools, view, list, store, dataDir };
}

const imgMsg = (attachment: any) => ({
  platform: "feishu", external_chat_id: "oc_x", pool_kind: "private", msg_id: "m_img_1",
  sender_id: "ou_1", sender_name: "主人", ts: Date.now(), text: "[图片]", reply_to: null,
  mentions: [], is_mention_me: false, media_type: "image", from_self: false, attachment,
}) as any;

test("view_image 把 inbox 里的图作为 image content 返回", async () => {
  const { view, dataDir } = setup();
  fs.mkdirSync(path.join(dataDir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "inbox", "shot.png"), PNG_1PX);
  const r: any = await view.execute("t1", { path: "shot.png" });
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[0].mimeType, "image/jpeg");
  assert.ok(r.content[0].data.length > 20);
  assert.match(r.content[1].text, /已加载/);
});

test("view_image 拒绝跳出两个沙箱目录的路径", async () => {
  const { view, dataDir } = setup();
  fs.mkdirSync(path.join(dataDir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "secret.txt"), "tok");
  for (const p of ["../secret.txt", "../../etc/passwd", "/etc/passwd", "media/../../secret.txt"]) {
    const r: any = await view.execute("t2", { path: p });
    assert.equal(r.content[0].type, "text", `应拒绝 ${p}`);
    assert.match(r.content[0].text, /没有这张图/);
  }
});

test("view_image 对不存在的文件给出提示而不是抛错", async () => {
  const { view, dataDir } = setup();
  fs.mkdirSync(path.join(dataDir, "inbox"), { recursive: true });
  const r: any = await view.execute("t3", { path: "nope.png" });
  assert.equal(r.content[0].type, "text");
  assert.match(r.content[0].text, /没有/);
});

test("list_images（inbox）分页、按修改时间从新到旧", async () => {
  const { list, dataDir } = setup();
  const inbox = path.join(dataDir, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const empty: any = await list.execute("l0", { source: "inbox" });
  assert.match(empty.content[0].text, /还没有能看的图片/);

  for (let i = 0; i < 5; i++) {
    const f = path.join(inbox, `p${i}.png`);
    fs.writeFileSync(f, PNG_1PX);
    fs.utimesSync(f, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
  }
  const p1: any = await list.execute("l1", { source: "inbox", page: 1, page_size: 2 });
  assert.match(p1.content[0].text, /共 5 张，第 1\/3 页/);
  assert.match(p1.content[0].text, /inbox\/p4\.png/);
  assert.match(p1.content[0].text, /inbox\/p3\.png/);
  assert.ok(!p1.content[0].text.includes("p2.png"));
  assert.match(p1.content[0].text, /page=2/);

  const p3: any = await list.execute("l3", { source: "inbox", page: 3, page_size: 2 });
  assert.match(p3.content[0].text, /第 3\/3 页/);
  assert.match(p3.content[0].text, /p0\.png/);
  assert.ok(!p3.content[0].text.includes("page=4"));

  const p9: any = await list.execute("l9", { source: "inbox", page: 9, page_size: 2 });
  assert.match(p9.content[0].text, /本页为空/);
});

test("list_images 能列出聊天里收到的图，view_image 能按 media/ 名字读回", async () => {
  const { list, view, store, dataDir } = setup();
  fs.mkdirSync(path.join(dataDir, "media"), { recursive: true });
  const a = saveImage(PNG_1PX, { dir: path.join(dataDir, "media"), maxEdge: 1024, maxBytes: 512000 }, "om_chat_1");
  store.insertMessage(imgMsg(a));

  const r: any = await list.execute("m1", { source: "media" });
  assert.match(r.content[0].text, /共 1 张/);
  assert.match(r.content[0].text, /media\/om_chat_1\.jpg/);
  assert.match(r.content[0].text, /消息#\d+/);

  const v: any = await view.execute("m2", { path: "media/om_chat_1.jpg" });
  assert.equal(v.content[0].type, "image");

  // 裸文件名也能找到
  const v2: any = await view.execute("m3", { path: "om_chat_1.jpg" });
  assert.equal(v2.content[0].type, "image");

  // view 的压缩缓存不会混进 media 列表
  const after: any = await list.execute("m4", { source: "media" });
  assert.match(after.content[0].text, /共 1 张/);
});
