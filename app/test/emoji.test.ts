import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmoji } from "../src/core/emoji.ts";

const map = { 微笑: { text: "🙂" }, 666: { sticker: "fk_666" }, 坏的: {} };

test("只解析 [emoji:中文id]，普通 [xxx] 原样", () => {
  assert.deepEqual(parseEmoji("你好[微笑][emoji:微笑]", map), [{ type: "text", text: "你好[微笑]🙂" }]);
});
test("匹配不上的 id 原样显示", () => {
  assert.deepEqual(parseEmoji("哈[emoji:不存在]哈", map), [{ type: "text", text: "哈[emoji:不存在]哈" }]);
  assert.deepEqual(parseEmoji("[emoji:坏的]", map), [{ type: "text", text: "[emoji:坏的]" }]);
});
test("表情包拆成独立段，保持顺序", () => {
  const segs = parseEmoji("牛 [emoji:666] 了", map);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[1], { type: "emoji", id: "666", target: { sticker: "fk_666" } });
  assert.equal((segs[0] as any).text, "牛 ");
});
test("只有表情包", () => {
  assert.deepEqual(parseEmoji("[emoji:666]", map).map((s) => s.type), ["emoji"]);
});
test("格式不对（空 id / 含空格）不解析", () => {
  assert.deepEqual(parseEmoji("[emoji:] [emoji:微 笑]", map), [{ type: "text", text: "[emoji:] [emoji:微 笑]" }]);
});
test("原型链属性不会被当成表情", () => {
  assert.deepEqual(parseEmoji("[emoji:constructor]", map), [{ type: "text", text: "[emoji:constructor]" }]);
});
