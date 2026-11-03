import { test } from "node:test";
import assert from "node:assert/strict";
import { checkStyle, normalize } from "../src/core/style-gate.ts";

const T = Date.parse("2026-11-03T19:00:00+08:00");

test("客服腔拦下来，并说清为什么", () => {
  for (const s of [
    "希望对你有帮助",
    "有什么可以帮你的吗",
    "请随时告诉我",
    "作为一个 AI，我觉得",
    "收到，我这就去办",
  ]) {
    const v = checkStyle({ text: s, now: T });
    assert.equal(v.ok, false, `应该拦：${s}`);
    assert.equal(v.reason, "banned");
    assert.ok(v.hint && v.hint.length > 4);
  }
});

test("八股腔也拦", () => {
  assert.equal(checkStyle({ text: "首先，我们要明确目标，其次再谈方法", now: T }).reason, "banned");
  assert.equal(checkStyle({ text: "总之，这件事没那么简单", now: T }).reason, "banned");
  assert.equal(checkStyle({ text: "这不仅仅是加班，更是对身体的消耗", now: T }).reason, "banned");
  assert.equal(checkStyle({ text: "在这个快节奏的时代，谁不累呢", now: T }).reason, "banned");
});

test("短话一律放过——废话是好的", () => {
  for (const s of ["嗯", "哈", "笑死", "我也是", "真的假的", "行", "…", "那你早点睡"]) {
    const v = checkStyle({ text: s, now: T });
    assert.equal(v.ok, true, `不该拦：${s}`);
  }
});

test("七天内的原样重复拦，标点和表情不算差别", () => {
  const recentSelf = [{ text: "钥匙弄了吗？", ts: T - 2 * 24 * 3600e3 }];
  const v = checkStyle({ text: "钥匙弄了吗", recentSelf, now: T });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "duplicate");
  assert.match(v.hint!, /2 天前/);

  const withEmoji = checkStyle({ text: "[emoji:微笑] 钥匙弄了吗", recentSelf, now: T });
  assert.equal(withEmoji.ok, false, "表情不算内容差别");
});

test("短句不判重：敷衍词本来就该反复说", () => {
  const recentSelf = [{ text: "嗯", ts: T - 3600e3 }, { text: "我也是", ts: T - 3600e3 }];
  assert.equal(checkStyle({ text: "嗯", recentSelf, now: T }).ok, true);
  assert.equal(checkStyle({ text: "我也是", recentSelf, now: T }).ok, true);
});

test("过了判重窗口就可以重说", () => {
  const recentSelf = [{ text: "钥匙弄了吗", ts: T - 9 * 24 * 3600e3 }];
  assert.equal(checkStyle({ text: "钥匙弄了吗", recentSelf, now: T }).ok, true);
});

test("换个说法不算重复", () => {
  const recentSelf = [{ text: "钥匙弄了吗", ts: T - 3600e3 }];
  assert.equal(checkStyle({ text: "钥匙到底弄了没啊", recentSelf, now: T }).ok, true);
});

test("太长只提醒不拦", () => {
  const long = "啊".repeat(200);
  const v = checkStyle({ text: long, now: T, maxChars: 160 });
  assert.equal(v.ok, true, "长不等于错，别把话吃掉");
  assert.equal(v.reason, "too_long");
  assert.match(v.hint!, /200/);
});

test("normalize 去掉标点空白和表情", () => {
  assert.equal(normalize("钥匙，弄了吗？"), "钥匙弄了吗");
  assert.equal(normalize("[emoji:微笑] 好的 "), "好的");
});
