/** 本地只读 map CLI：直接读 SQLite，按图统计。 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/db.ts";
import { replaceBusinessMap } from "../src/ops/business-map.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-map-cli-"));
const db = path.join(root, "rabbit-bot.db");
const script = path.resolve(import.meta.dirname, "..", "scripts", "map.ts");

const snapshot = {
  version: 1,
  types: [{ id: "service", name: "服务" }, { id: "env", name: "环境" }],
  objects: [
    { id: "service:a", type: "service", name: "a" },
    { id: "env:prod", type: "env", name: "prod" },
    { id: "service:b", type: "service", name: "b", graph_id: "runsenshen" },
    { id: "env:qa", type: "env", name: "qa", graph_id: "runsenshen" },
  ],
  relations: [
    { id: "deploys", name: "deploys_to", fromType: "service", toType: "env", cardinality: "N:N", risk: "high" },
    { id: "deploys_rs", name: "deploys_to", fromType: "service", toType: "env", cardinality: "N:N", risk: "high", graph_id: "runsenshen" },
  ],
  edges: [
    { relation: "deploys", from: "service:a", to: "env:prod", evidence: "test" },
    { relation: "deploys_rs", from: "service:b", to: "env:qa", evidence: "test", graph_id: "runsenshen" },
  ],
  actions: [],
  terms: [],
};

test.before(() => {
  const store = new Store(db);
  replaceBusinessMap(store, snapshot);
  store.close();
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("map graphs：按 graph_id 统计对象/关系/边", () => {
  const out = execFileSync(process.execPath, ["--import", "tsx", script, "graphs", "--db", db], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  assert.match(out, /default: 2 对象 \/ 1 关系 \/ 1 边/);
  assert.match(out, /runsenshen: 2 对象 \/ 1 关系 \/ 1 边/);
});

test("map show：输出对象和图谱", () => {
  const out = execFileSync(process.execPath, ["--import", "tsx", script, "show", "service:b", "--db", db], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  assert.match(out, /service:b/);
  assert.match(out, /graph=runsenshen/);
  assert.match(out, /deploys_to/);
});
