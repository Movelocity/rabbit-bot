/**
 * 模板层：替换、缺变量报错、mtime 缓存。
 * 模板本身是纯文本（没有 if / for），所以这里能测的就这三件事。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render, setTemplateDir, templateDir, listTemplates } from "../src/agent/template.ts";

test("真实模板都在：主提示词 + 三份场景 + 三个附件", () => {
  const names = listTemplates();
  for (const n of ["system", "wake", "scene-message", "scene-tick", "scene-plan", "handoff", "part-topics"]) {
    assert.ok(names.includes(n), `缺模板 ${n}.md（现有：${names.join(", ")}）`);
  }
  // 已删的四份（part-tide / part-proactive / part-plan-why / part-plan-nowhy）不该再回来：
  // 它们的文案并进了唤醒消息的「状态」块和 scene-*.md，留着会两处说法打架
  for (const gone of ["part-tide", "part-proactive", "part-plan-why", "part-plan-nowhy"]) {
    assert.ok(!names.includes(gone), `${gone}.md 已并入别处，不该再存在`);
  }
  assert.match(templateDir(), /data\/sandbox\/prompt$/);
});

test("handoff 渲染出来是那段交接要求", () => {
  const s = render("handoff", {});
  assert.match(s, /交接文档/);
  assert.match(s, /不要调用任何工具/);
});

test("缺变量直接抛错，并说清缺了哪个", () => {
  assert.throws(() => render("system", {}), /缺少变量.*agent_name/);
  // 少一个也报
  assert.throws(() => render("system", { agent_name: "克劳德", persona: "人设" }), /emoji_block/);
});

test("多传变量不报错（代码可以先传着，模板后加）", () => {
  assert.doesNotThrow(() => render("scene-message", { 没用的: "x" }));
});

test("同一文件改了就重新读，没改就用缓存", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-tpl-"));
  const f = path.join(dir, "demo.md");
  fs.writeFileSync(f, "第一版 {{x}}");
  setTemplateDir(dir);
  try {
    assert.equal(render("demo", { x: "1" }), "第一版 1");
    // 改内容 + 把 mtime 往后推，模拟编辑器保存
    fs.writeFileSync(f, "第二版 {{x}}");
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(f, later, later);
    assert.equal(render("demo", { x: "2" }), "第二版 2");
    // 模板不存在 → 抛错，不是空串
    assert.throws(() => render("不存在", {}));
  } finally {
    setTemplateDir(path.resolve(import.meta.dirname, "..", "config", "prompt"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
