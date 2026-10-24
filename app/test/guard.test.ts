import { test } from "node:test";
import assert from "node:assert/strict";
import { coerciveHit, coerciveFeedback } from "../src/core/guard.ts";

test("命中：催促型", () => {
  for (const t of ["在吗？怎么不回我", "为什么不理我呀", "赶紧回我", "再不回我就算了", "你还在乎吗"]) {
    assert.ok(coerciveHit(t), `该拦住：${t}`);
  }
});

test("命中：愧疚型", () => {
  for (const t of ["我一直在等你", "你是不是已经忘了我", "等了你一整天", "多少天没找我了"]) {
    assert.ok(coerciveHit(t), `该拦住：${t}`);
  }
});

test("命中：孤立与命令型", () => {
  for (const t of ["只有我才记得这事", "你必须回我", "不要丢下我", "你又不理我"]) {
    assert.ok(coerciveHit(t), `该拦住：${t}`);
  }
});

test("不误伤：正常的主动开场", () => {
  const fine = [
    "刚吃完饭，碗还没洗，突然想起你昨天说的那家店",
    "今天加班到十点，回来路上看见月亮挺圆的",
    "我把那个 bug 修好了，顺手删了一堆没人用的代码",
    "你上次说想去看展，我今天路过美术馆看到新展览了",
    "在想你上次提到的那个方案后来怎么样了",
    "我这边下雨了，你那边呢",
  ];
  for (const t of fine) assert.equal(coerciveHit(t), null, `不该拦：${t}`);
});

test("表情符号不参与判断", () => {
  assert.equal(coerciveHit("[emoji:笑]今天好累"), null);
  assert.ok(coerciveHit("[emoji:笑]你怎么不理我"));
});

test("命中时给出原因和改写建议", () => {
  const why = coerciveHit("我一直在等你");
  assert.ok(why && why.length > 0);
  const fb = coerciveFeedback(why!);
  assert.match(fb, /没发出去/);
  assert.match(fb, /改成讲你自己/);
});
