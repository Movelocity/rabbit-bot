/**
 * 一次性迁移：#62 并入的 codex 批次搬进独立图谱。
 *
 * 先用 #62 之前的快照（base62.json）做差集，认出 codex 批次的对象/关系/边，
 * 再把它们的 graph_id / import_batch 改掉；其余记录保持默认图谱。
 * 只改 graph_id / import_batch，不动 evidence，可重复执行。
 *
 * 用法（在 app/ 下）：
 *   node --import tsx scripts/migrate-business-graphs.ts \
 *     --db data/rabbit-bot.db --base ../.scratch/task62/base62.json \
 *     --graph codex --batch codex-62
 */
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/core/db.ts";

const appDir = path.resolve(import.meta.dirname, "..");
const repoDir = path.resolve(appDir, "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbFile = path.resolve(process.cwd(), arg("--db", path.join(appDir, "data/rabbit-bot.db")));
const baseFile = path.resolve(process.cwd(), arg("--base", path.join(repoDir, ".scratch/task62/base62.json")));
const graph = arg("--graph", "codex").trim() || "codex";
const batch = arg("--batch", "codex-62").trim() || "codex-62";

const base = JSON.parse(fs.readFileSync(baseFile, "utf8"));
const baseObjects = new Set<string>(base.objects.map((o: any) => String(o.id)));
const baseRelations = new Set<string>(base.relations.map((r: any) => String(r.id)));
const baseEdges = new Set<string>(base.edges.map((e: any) => `${e.relation}|${e.from}|${e.to}`));

const store = new Store(dbFile);
const objects = store.listBusinessObjects();
const relations = store.listBusinessRelations();
const edges = store.listBusinessEdges();

const newObjectIds = objects.map((o) => String(o.id)).filter((id) => !baseObjects.has(id));
const newRelationIds = relations.map((r) => String(r.id)).filter((id) => !baseRelations.has(id));
const newEdges = edges
  .map((e) => ({ relation: String(e.relation_id), from: String(e.from_id), to: String(e.to_id) }))
  .filter((e) => !baseEdges.has(`${e.relation}|${e.from}|${e.to}`));

const expected = { objects: 79, relations: 54, edges: 55 };
if (newObjectIds.length !== expected.objects || newRelationIds.length !== expected.relations || newEdges.length !== expected.edges) {
  console.error(
    `[migrate] 差集数量不符合预期：objects=${newObjectIds.length}（期望 ${expected.objects}），`
    + `relations=${newRelationIds.length}（期望 ${expected.relations}），edges=${newEdges.length}（期望 ${expected.edges}）`,
  );
  store.close();
  process.exit(1);
}

const tx = store.db.transaction(() => {
  store.db.prepare("UPDATE business_objects SET graph_id='default', import_batch=''").run();
  store.db.prepare("UPDATE business_relations SET graph_id='default', import_batch=''").run();
  store.db.prepare("UPDATE business_edges SET graph_id='default', import_batch=''").run();

  const objStmt = store.db.prepare("UPDATE business_objects SET graph_id=?, import_batch=? WHERE id=?");
  for (const id of newObjectIds) objStmt.run(graph, batch, id);
  const relStmt = store.db.prepare("UPDATE business_relations SET graph_id=?, import_batch=? WHERE id=?");
  for (const id of newRelationIds) relStmt.run(graph, batch, id);
  const edgeStmt = store.db.prepare(
    "UPDATE business_edges SET graph_id=?, import_batch=? WHERE relation_id=? AND from_id=? AND to_id=?",
  );
  for (const e of newEdges) edgeStmt.run(graph, batch, e.relation, e.from, e.to);
});
tx();

const byGraph = store.db.prepare(
  "SELECT graph_id, import_batch, count(*) AS n FROM business_objects GROUP BY graph_id, import_batch ORDER BY graph_id",
).all() as any[];
console.log(`[migrate] ${dbFile}`);
console.log(`[migrate] 新图谱 ${graph}，批次 ${batch}`);
console.log(`[migrate] 对象：${newObjectIds.length}，关系：${newRelationIds.length}，边：${newEdges.length}`);
console.log(`[migrate] 对象分布：${JSON.stringify(byGraph)}`);
store.close();
