import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveImage, toImageContent } from "../src/core/media.ts";
import { imageKeyOf } from "../src/adapters/feishu.ts";
import { execFileSync } from "node:child_process";

/** 1x1 透明 PNG，够 sips 解析 */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-media-"));
}

test("saveImage 不放大图：小图保持原尺寸", () => {
  const dir = tmpDir();
  const a = saveImage(PNG_1PX, { dir, maxEdge: 1024, maxBytes: 512000 }, "msg_small");
  assert.equal(a.width, 1);
  assert.equal(a.height, 1);
});

test("saveImage 把长边压到 maxEdge", () => {
  const dir = tmpDir();
  const big = path.join(dir, "big.png");
  fs.writeFileSync(big, PNG_1PX);
  // 借 sips 造一张 2048 宽的图
  execFileSync("sips", ["-z", "2048", "2048", big, "--out", big]);
  const raw = fs.readFileSync(big);
  const a = saveImage(raw, { dir, maxEdge: 1024, maxBytes: 512000 }, "msg_big");
  assert.equal(Math.max(a.width, a.height), 1024);
});

test("saveImage 落盘成 jpeg，并带回尺寸与字节数", () => {
  const dir = tmpDir();
  const a = saveImage(PNG_1PX, { dir, maxEdge: 1024, maxBytes: 512000 }, "msg_1");
  assert.equal(a.mime, "image/jpeg");
  assert.ok(fs.existsSync(a.path));
  assert.ok(a.bytes > 0);
  assert.equal(a.width, 1);
  assert.equal(a.height, 1);
  // 中间文件不残留
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".src")).length, 0);
});

test("saveImage 对非法 key 也安全（不逃出目录）", () => {
  const dir = tmpDir();
  const a = saveImage(PNG_1PX, { dir, maxEdge: 1024, maxBytes: 512000 }, "../../etc/passwd");
  assert.ok(a.path.startsWith(dir));
});

test("toImageContent 给出 base64 与 mime；非图片返回 null", () => {
  const dir = tmpDir();
  const a = saveImage(PNG_1PX, { dir, maxEdge: 1024, maxBytes: 512000 }, "msg_2");
  const c = toImageContent(a);
  assert.ok(c);
  assert.equal(c!.type, "image");
  assert.equal(c!.mimeType, "image/jpeg");
  assert.equal(Buffer.from(c!.data, "base64").length, a.bytes);

  assert.equal(toImageContent({ ...a, mime: "application/octet-stream" }), null);
  assert.equal(toImageContent({ ...a, path: path.join(dir, "nope.jpg") }), null);
});

test("imageKeyOf 认 image 与富文本里的 img", () => {
  assert.equal(imageKeyOf("image", JSON.stringify({ image_key: "img_v3_abc" })), "img_v3_abc");
  assert.equal(imageKeyOf("image", "{bad json"), null);
  assert.equal(imageKeyOf("image", JSON.stringify({ file_key: "x" })), null);
  const post = JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: "看这个" }], [{ tag: "img", image_key: "img_v2_post" }]] } });
  assert.equal(imageKeyOf("post", post), "img_v2_post");
  assert.equal(imageKeyOf("post", JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: "纯文字" }]] } })), null);
  assert.equal(imageKeyOf("text", JSON.stringify({ text: "hi" })), null);
});
