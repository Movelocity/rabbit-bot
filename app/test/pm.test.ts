/** 项目体检判定器：七条规则的边界值。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTask, auditTasks, renderPmReport, type PmTaskRow } from "../src/core/pm.ts";

const NOW = new Date("2026-11-12T20:00:00+08:00").getTime();
const H = 3600_000;

function row(p: Partial<PmTaskRow> = {}): PmTaskRow {
  return {
    id: 1,
    name: "SPU 归并",
    goal: "把 22 个 SKU 归到 13 个 SPU",
    acceptance: "22 个 SKU 全部有归属，0 个孤儿",
    status: "running",
    doc_path: "/work/.ufa/tasks/task-1.md",
    result: "",
    artifact: "",
    note: "",
    lease_until: NOW + H,
    created_at: NOW - H,
    updated_at: NOW - 30 * 60_000,
    end_at: null,
    ...p,
  };
}

test("干净的任务不出问题", () => {
  assert.deepEqual(auditTask(row(), { now: NOW }), []);
});

test("没验收就开工 → 红", () => {
  const f = auditTask(row({ acceptance: "  " }), { now: NOW });
  assert.equal(f.length, 1);
  assert.equal(f[0].code, "no-acceptance");
  assert.equal(f[0].level, "red");
});

test("租约过期 → 红（失联）", () => {
  const f = auditTask(row({ lease_until: NOW - 1000 }), { now: NOW });
  assert.equal(f[0].code, "lease-expired");
  assert.equal(f[0].level, "red");
});

test("静默超过 2 小时 → 黄；1 小时不算", () => {
  assert.equal(auditTask(row({ updated_at: NOW - H }), { now: NOW }).length, 0);
  const f = auditTask(row({ updated_at: NOW - 3 * H }), { now: NOW });
  assert.equal(f[0].code, "stalled");
  assert.equal(f[0].level, "yellow");
});

test("没有交接文档 → 黄", () => {
  const f = auditTask(row({ doc_path: "" }), { now: NOW });
  assert.equal(f[0].code, "no-handoff-doc");
});

test("开了 8 天没收口 → 红；6 天不算", () => {
  assert.equal(auditTask(row({ created_at: NOW - 6 * 24 * H }), { now: NOW }).length, 0);
  const f = auditTask(row({ created_at: NOW - 8 * 24 * H }), { now: NOW });
  assert.equal(f[0].code, "overdue");
  assert.equal(f[0].level, "red");
});

test("有结论没落盘 → 黄；已完成缺结果 → 黄", () => {
  assert.equal(auditTask(row({ status: "done", result: "做完了" }), { now: NOW })[0].code, "no-artifact");
  assert.equal(auditTask(row({ status: "done", result: "" }), { now: NOW })[0].code, "done-without-result");
});

test("汇总：结论句带数字，红优先渲染", () => {
  const rows = [
    row({ id: 1 }),
    row({ id: 2, acceptance: "" }),
    row({ id: 3, status: "done", result: "x" }),
  ];
  const rep = auditTasks(rows, { now: NOW });
  assert.equal(rep.red, 1);
  assert.equal(rep.yellow, 1);
  assert.match(rep.headline, /2 个在跑任务，1 项红、1 项黄/);
  const md = renderPmReport(rep, rows, new Date(NOW));
  assert.ok(md.indexOf("红（要处理）") < md.indexOf("黄（要盯）"));
});
