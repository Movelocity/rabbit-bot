/** 图片：view_image 工具（进上下文）+ ops/images 的索引。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { saveImage } from "../src/core/media.ts";
import { listImages } from "../src/ops/images.ts";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-tool-"));
  const cfg = { ...loadConfig(), dataDir };
  const store = new Store(":memory:");
  const hub = {} as any;
  const tools = createTools({ store, hub, cfg, now: () => Date.now() }) as any[];
  const view = tools.find((t) => t.name === "view_image");
  return { cfg, tools, view, store, dataDir };
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

test("img-list（inbox）分页、按修改时间从新到旧", () => {
  const { store, dataDir } = setup();
  const inbox = path.join(dataDir, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  assert.equal(listImages(store, dataDir, { source: "inbox" }).total, 0);

  for (let i = 0; i < 5; i++) {
    const f = path.join(inbox, `p${i}.png`);
    fs.writeFileSync(f, PNG_1PX);
    fs.utimesSync(f, new Date(2026, 0, i + 1), new Date(2026, 0, i + 1));
  }
  const p1 = listImages(store, dataDir, { source: "inbox", page: 1, size: 2 });
  assert.equal(p1.total, 5);
  assert.equal(p1.pages, 3);
  assert.deepEqual(p1.items.map((i) => i.name), ["inbox/p4.png", "inbox/p3.png"]);

  const p3 = listImages(store, dataDir, { source: "inbox", page: 3, size: 2 });
  assert.deepEqual(p3.items.map((i) => i.name), ["inbox/p0.png"]);

  const p9 = listImages(store, dataDir, { source: "inbox", page: 9, size: 2 });
  assert.deepEqual(p9.items, []);
});

test("img-list 能列出聊天里收到的图，view_image 能按 media/ 名字读回", async () => {
  const { view, store, dataDir } = setup();
  fs.mkdirSync(path.join(dataDir, "media"), { recursive: true });
  const a = saveImage(PNG_1PX, { dir: path.join(dataDir, "media"), maxEdge: 1024, maxBytes: 512000 }, "om_chat_1");
  store.insertMessage(imgMsg(a));

  const r = listImages(store, dataDir, { source: "media" });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].name, "media/om_chat_1.jpg");
  assert.match(r.items[0].note ?? "", /消息#\d+/);

  const v: any = await view.execute("m2", { path: "media/om_chat_1.jpg" });
  assert.equal(v.content[0].type, "image");

  const v2: any = await view.execute("m3", { path: "om_chat_1.jpg" });
  assert.equal(v2.content[0].type, "image");

  // view 的压缩缓存不会混进 media 列表
  assert.equal(listImages(store, dataDir, { source: "media" }).total, 1);
});
