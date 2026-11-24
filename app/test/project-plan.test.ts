import test from "node:test";
import assert from "node:assert/strict";
import { nextStepOf } from "../webapp/src/lib/plan.ts";

test("下一步：结构化待办取第一条未完成，跳过已勾选", () => {
  const plan = [
    "# 项目",
    "",
    "## 下一步",
    "- [x] 已完成 A",
    "- [ ] 第一条未完成",
    "- [ ] 第二条",
    "",
    "## 背景",
    "- [ ] 背景里的不算",
  ].join("\n");
  assert.equal(nextStepOf(plan), "第一条未完成");
});

test("下一步：跨行的一条拼完整，不截成半句", () => {
  const plan = [
    "## 下一步",
    "- [ ] 先把发版路径查清楚，",
    "  再把任务卡补齐",
    "- [ ] 第二条",
  ].join("\n");
  assert.equal(nextStepOf(plan), "先把发版路径查清楚， 再把任务卡补齐");
});

test("下一步：全部勾完就没有下一步，不退回背景段落", () => {
  const plan = [
    "## 下一步",
    "- [x] 做完了",
    "- [x] 也做完了",
    "",
    "## 背景",
    "这是背景段落，不该当下一步。",
  ].join("\n");
  assert.equal(nextStepOf(plan), "");
});

test("下一步：行内写法直接取标签后的内容", () => {
  assert.equal(nextStepOf("## 下一步：等 A1~A3 拍板\n其他"), "等 A1~A3 拍板");
});

test("下一步：没有结构时退回第一个非标题行（与旧行为一致）", () => {
  assert.equal(nextStepOf("# 标题\n\n第一段正文内容"), "第一段正文内容");
  assert.equal(nextStepOf(""), "");
});
