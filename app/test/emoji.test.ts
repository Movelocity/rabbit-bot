import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { EmojiTable, parseEmoji, inboundEmojiText } from "../src/core/emoji.ts";
import { buildFeishuPost, feishuContentToText } from "../src/adapters/feishu.ts";
import { APP_ROOT } from "../src/config.ts";

const TABLE_FILE = path.join(APP_ROOT, "config/emoji-feishu.json");
const overrides = { 微笑: { text: "🙂" }, 666: { sticker: "fk_666" }, 坏的: {} };
const ovr = new EmojiTable([], overrides); // 只有覆盖、无飞书表
const ft = EmojiTable.load(TABLE_FILE); // 真实飞书表

// —— 旧行为（覆盖表） ——
test("只解析 [emoji:中文id]，普通 [xxx] 原样", () => {
  assert.deepEqual(parseEmoji("你好[微笑][emoji:微笑]", ovr), [{ type: "text", text: "你好[微笑]🙂" }]);
});
test("匹配不上的 id 原样显示", () => {
  assert.deepEqual(parseEmoji("哈[emoji:不存在]哈", ovr), [{ type: "text", text: "哈[emoji:不存在]哈" }]);
  assert.deepEqual(parseEmoji("[emoji:坏的]", ovr), [{ type: "text", text: "[emoji:坏的]" }]);
  assert.deepEqual(parseEmoji("哈[emoji:不存在]哈", ft), [{ type: "text", text: "哈[emoji:不存在]哈" }]);
});
test("表情包拆成独立段，保持顺序", () => {
  const segs = parseEmoji("牛 [emoji:666] 了", ovr);
  assert.equal(segs.length, 3);
  assert.equal(segs[1].type, "emoji");
  assert.equal((segs[1] as any).entry.sticker, "fk_666");
  assert.equal((segs[0] as any).text, "牛 ");
});
test("格式不对（空 id / 含空格）不解析", () => {
  assert.deepEqual(parseEmoji("[emoji:] [emoji:微 笑]", ft), [{ type: "text", text: "[emoji:] [emoji:微 笑]" }]);
});
test("原型链属性不会被当成表情", () => {
  assert.deepEqual(parseEmoji("[emoji:constructor] [emoji:__proto__]", ft), [{ type: "text", text: "[emoji:constructor] [emoji:__proto__]" }]);
});

// —— 飞书表 ——
test("映射表：182 个飞书 emoji_type，key / 名字无冲突，常用 ~30 个", () => {
  const raw = JSON.parse(fs.readFileSync(TABLE_FILE, "utf8")).emojis as { id: string; feishu: string; aliases?: string[] }[];
  assert.equal(raw.length, 182);
  assert.equal(new Set(raw.map((e) => e.feishu)).size, 182);
  const owner = new Map<string, string>();
  for (const e of raw) for (const n of [e.id, ...(e.aliases ?? []), e.feishu].map((x) => x.toLowerCase())) {
    assert.ok(!owner.has(n) || owner.get(n) === e.id, `名字冲突: ${n}`);
    owner.set(n, e.id);
  }
  const common = ft.commonIds();
  assert.ok(common.length >= 25 && common.length <= 45, String(common.length));
  for (const id of ["微笑", "捂脸", "强", "玫瑰", "OK", "合十", "大笑"]) assert.ok(common.includes(id), id);
});
test("微信式 id / 别名 / 飞书 key（不分大小写）都能对上", () => {
  assert.equal(ft.resolve("微笑")?.feishu, "SMILE");
  assert.equal(ft.resolve("捂脸")?.feishu, "FACEPALM");
  assert.equal(ft.resolve("强")?.feishu, "THUMBSUP");
  assert.equal(ft.resolve("赞")?.feishu, "THUMBSUP");
  assert.equal(ft.resolve("玫瑰")?.feishu, "ROSE");
  assert.equal(ft.resolve("thumbsup")?.id, "强");
  assert.equal(ft.resolve("Smile")?.id, "微笑");
  assert.equal(ft.byFeishuKey("FACEPALM")?.id, "捂脸");
});
test("出站：文字和飞书表情交错，保持顺序", () => {
  const segs = parseEmoji("哈哈[emoji:捂脸]，给你[emoji:赞][emoji:玫瑰]", ft);
  assert.deepEqual(segs.map((s) => (s.type === "text" ? s.text : `<${s.entry.feishu}>`)), ["哈哈", "<FACEPALM>", "，给你", "<THUMBSUP>", "<ROSE>"]);
  assert.equal((segs[3] as any).id, "强"); // 别名归一到 id
});
test("覆盖优先于飞书表（文字替换 / 表情包）", () => {
  const t = EmojiTable.load(TABLE_FILE, overrides);
  assert.deepEqual(parseEmoji("[emoji:微笑]", t), [{ type: "text", text: "🙂" }]);
  assert.equal((parseEmoji("[emoji:666]", t)[0] as any).entry.sticker, "fk_666");
  assert.equal((parseEmoji("[emoji:捂脸]", t)[0] as any).entry.feishu, "FACEPALM");
});
test("飞书 post 构造：emotion 元素 + 按换行分段", () => {
  const post = buildFeishuPost([{ type: "text", text: "好的" }, { type: "emoji", id: "强", key: "THUMBSUP" }, { type: "text", text: "\n第二行" }]);
  assert.deepEqual(post, { zh_cn: { content: [
    [{ tag: "text", text: "好的" }, { tag: "emotion", emoji_type: "THUMBSUP" }],
    [{ tag: "text", text: "第二行" }],
  ] } });
});
test("入站文本：[名字] → [emoji:id]，不认识的、链接、已转换的保持原样", () => {
  assert.equal(inboundEmojiText("笑死[捂脸][赞]", ft), "笑死[emoji:捂脸][emoji:强]");
  assert.equal(inboundEmojiText("[Smile] [THUMBSUP]", ft), "[emoji:微笑] [emoji:强]");
  assert.equal(inboundEmojiText("[不知道] [文档](https://x.y) [emoji:微笑]", ft), "[不知道] [文档](https://x.y) [emoji:微笑]");
});
test("入站飞书消息：text / post emotion / 表情包", () => {
  assert.equal(feishuContentToText("text", JSON.stringify({ text: "好[捂脸]" }), [], ft).text, "好[emoji:捂脸]");
  const post = { zh_cn: { title: "", content: [[{ tag: "text", text: "收到" }, { tag: "emotion", emoji_type: "OK" }, { tag: "emotion", emoji_type: "NOT_A_KEY" }]] } };
  assert.equal(feishuContentToText("post", JSON.stringify(post), [], ft).text, "收到[emoji:OK][表情:NOT_A_KEY]");
  assert.deepEqual(feishuContentToText("sticker", JSON.stringify({ file_key: "x" }), [], ft), { text: "[表情包]", media: "sticker" });
});
