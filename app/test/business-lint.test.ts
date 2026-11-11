import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { replaceBusinessMap } from "../src/ops/business-map.ts";
import { lintBusinessMap, readBusinessLintReport, writeBusinessLintReport } from "../src/ops/business-lint.ts";

const snapshot = {
  version: 1,
  types: [
    { id: "service", name: "服务" },
    { id: "env", name: "环境" },
    { id: "project", name: "项目" },
    { id: "repo", name: "仓库" },
  ],
  objects: [
    { id: "service:a", type: "service", name: "a", aliases: ["api"] },
    { id: "service:b", type: "service", name: "b", aliases: ["api"] },
    { id: "env:prod", type: "env", name: "prod" },
    { id: "project:p", type: "project", name: "p" },
  ],
  relations: [
    { id: "svc_env", name: "deploys_to", fromType: "service", toType: "env", risk: "high" },
    { id: "svc_project", name: "belongs_to", fromType: "service", toType: "project" },
  ],
  edges: [{ relation: "svc_env", from: "service:a", to: "env:prod" }],
  actions: [],
  terms: [],
};

test("空库：报告 map.empty，不报错", () => {
  const store = new Store(":memory:");
  const report = lintBusinessMap(store);
  assert.equal(report.exists, false);
  assert.ok(report.findings.some((f) => f.code === "map.empty"));
  store.close();
});

test("常见异常：没边、没证据、高风险没语义、别名重复、空类型、孤立对象", () => {
  const store = new Store(":memory:");
  replaceBusinessMap(store, snapshot);
  const report = lintBusinessMap(store);
  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has("relation.no_edges"), "svc_project 没有边");
  assert.ok(codes.has("edge.no_evidence"), "边没写 evidence");
  assert.ok(codes.has("relation.high_no_semantics"), "高风险关系没写 semantics");
  assert.ok(codes.has("object.duplicate_alias"), "两个对象共用别名 api");
  assert.ok(codes.has("type.empty"), "repo 类型没有对象");
  assert.ok(codes.has("object.isolated"), "project:p 没有边");
  assert.equal(report.summary.error, 0);
  assert.ok(report.summary.warn >= 3);
  store.close();
});

test("坏引用：悬空边/术语/类型都报 error", () => {
  const store = new Store(":memory:");
  replaceBusinessMap(store, snapshot);
  store.db.prepare("INSERT INTO business_edges(relation_id,from_id,to_id,evidence,updated_at) VALUES(?,?,?,?,?)")
    .run("nope", "service:nope", "env:nope", "", 0);
  store.db.prepare("INSERT INTO business_terms(term,object_id,note) VALUES(?,?,?)")
    .run("坏术语", "service:nope", "");
  store.db.prepare("INSERT INTO business_objects(id,type,name,description,key_kind,key_value,source_kind,source_value,aliases,tags) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("weird:x", "nope-type", "x", "", null, null, null, null, "[]", "[]");

  const report = lintBusinessMap(store);
  const codes = new Set(report.findings.map((f) => f.code));
  assert.ok(codes.has("edge.relation_missing"));
  assert.ok(codes.has("edge.from_missing"));
  assert.ok(codes.has("edge.to_missing"));
  assert.ok(codes.has("term.object_missing"));
  assert.ok(codes.has("object.type_missing"));
  assert.ok(report.summary.error >= 5);
  store.close();
});

test("报告落盘到运行时目录，能读回", () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-lint-"));
  const cfg = loadConfig({ runtimeDir });
  const store = new Store(":memory:");
  replaceBusinessMap(store, snapshot);
  const report = lintBusinessMap(store);
  writeBusinessLintReport(cfg, report);
  assert.ok(fs.existsSync(path.join(runtimeDir, "business-lint.json")));
  const back = readBusinessLintReport(cfg);
  assert.equal(back?.version, 1);
  assert.equal(back?.counts.objects, 4);
  store.close();
  fs.rmSync(runtimeDir, { recursive: true, force: true });
});
