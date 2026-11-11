/**
 * 业务地图 lint：只读检查，不改数据。
 *
 * 目标是把「显式边不会自己算」带来的隐性缺口报出来：悬空引用、有类型没边、
 * 高风险关系没语义、边没证据、对象/别名重复、孤立对象。报告写到运行时目录，
 * 供 Web 和 UFA 主动维护查看。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import { runtimePath } from "../core/runtime.ts";

export type LintLevel = "error" | "warn" | "info";

export interface BusinessLintFinding {
  level: LintLevel;
  code: string;
  message: string;
  ref?: string;
  graph?: string;
}

export interface BusinessLintGraphCounts {
  objects: number;
  relations: number;
  edges: number;
}

export interface BusinessLintReport {
  checked_at: number;
  exists: boolean;
  version: number | null;
  counts: {
    types: number; objects: number; relations: number; edges: number; actions: number; terms: number;
    graphs: Record<string, BusinessLintGraphCounts>;
  };
  findings: BusinessLintFinding[];
  summary: { error: number; warn: number; info: number };
  summary_by_graph: Record<string, { error: number; warn: number; info: number }>;
}

function makeReport(
  meta: Record<string, string>,
  counts: BusinessLintReport["counts"],
  findings: BusinessLintFinding[],
): BusinessLintReport {
  const summary = { error: 0, warn: 0, info: 0 };
  const summaryByGraph: BusinessLintReport["summary_by_graph"] = {};
  for (const f of findings) {
    summary[f.level]++;
    if (f.graph === undefined) continue;
    const g = (summaryByGraph[f.graph] ??= { error: 0, warn: 0, info: 0 });
    g[f.level]++;
  }
  return {
    checked_at: Date.now(),
    exists: !!meta.version || counts.objects > 0 || counts.relations > 0,
    version: meta.version ? Number(meta.version) : null,
    counts,
    findings,
    summary,
    summary_by_graph: summaryByGraph,
  };
}

export function lintBusinessMap(store: Store): BusinessLintReport {
  const meta = store.businessMetaAll();
  const types = store.listBusinessTypes();
  const objects = store.listBusinessObjects();
  const relations = store.listBusinessRelations();
  const edges = store.listBusinessEdges();
  const actions = store.listBusinessActions();
  const terms = store.listBusinessTerms();
  const graphs: Record<string, BusinessLintGraphCounts> = {};
  const bump = (graph: unknown, key: keyof BusinessLintGraphCounts) => {
    const g = String(graph ?? "default") || "default";
    const row = (graphs[g] ??= { objects: 0, relations: 0, edges: 0 });
    row[key]++;
  };
  for (const o of objects) bump(o.graph_id, "objects");
  for (const r of relations) bump(r.graph_id, "relations");
  for (const e of edges) bump(e.graph_id, "edges");
  const counts = {
    types: types.length, objects: objects.length, relations: relations.length,
    edges: edges.length, actions: actions.length, terms: terms.length, graphs,
  };
  const findings: BusinessLintFinding[] = [];
  const add = (level: LintLevel, code: string, message: string, ref?: string, graph?: string) =>
    findings.push({ level, code, message, ...(ref ? { ref } : {}), ...(graph ? { graph } : {}) });

  const typeIds = new Set(types.map((t) => String(t.id)));
  const objectIds = new Set(objects.map((o) => String(o.id)));
  const relationIds = new Set(relations.map((r) => String(r.id)));
  const objectGraph = new Map(objects.map((o) => [String(o.id), String(o.graph_id ?? "default") || "default"]));
  const relationGraph = new Map(relations.map((r) => [String(r.id), String(r.graph_id ?? "default") || "default"]));

  if (!counts.objects && !counts.relations && !meta.version) {
    add("info", "map.empty", "还没有业务地图。先用 PUT /v1/business 写入对象和关系。");
    return makeReport(meta, counts, findings);
  }

  // 引用完整性（正常写入会校验，这里防旧库/手工改库）
  for (const o of objects) {
    const graph = objectGraph.get(String(o.id));
    if (!typeIds.has(String(o.type))) add("error", "object.type_missing", `对象 ${o.id} 的 type「${o.type}」没有声明`, String(o.id), graph);
    if (!o.key_value) add("info", "object.no_key", `对象 ${o.id} 没有 key，后续去重/匹配只能靠 id/name`, String(o.id), graph);
  }
  for (const r of relations) {
    const graph = relationGraph.get(String(r.id));
    if (!typeIds.has(String(r.from_type))) add("error", "relation.from_type_missing", `关系 ${r.id} 的 fromType「${r.from_type}」没有声明`, String(r.id), graph);
    if (!typeIds.has(String(r.to_type))) add("error", "relation.to_type_missing", `关系 ${r.id} 的 toType「${r.to_type}」没有声明`, String(r.id), graph);
    if (r.risk === "high" && !String(r.semantics ?? "").trim()) {
      add("warn", "relation.high_no_semantics", `高风险关系 ${r.id} 没写 semantics，impact 时说不清会影响什么`, String(r.id), graph);
    }
    if (!r.cardinality) add("info", "relation.no_cardinality", `关系 ${r.id} 没写 cardinality`, String(r.id), graph);
    if (!r.direction) add("info", "relation.no_direction", `关系 ${r.id} 没写 direction`, String(r.id), graph);
  }
  const edgeByRelation = new Map<string, number>();
  const touched = new Set<string>();
  for (const e of edges) {
    const rel = String(e.relation_id);
    const from = String(e.from_id);
    const to = String(e.to_id);
    const graph = String(e.graph_id ?? "default") || "default";
    if (!relationIds.has(rel)) add("error", "edge.relation_missing", `边引用了不存在的关系 ${rel}`, `${from}->${to}`, graph);
    else if (relationGraph.get(rel) !== graph) {
      add("error", "edge.graph_mismatch", `边 ${rel} ${from}->${to} 的图谱「${graph}」和关系的「${relationGraph.get(rel)}」不一致`, `${from}->${to}`, graph);
    }
    if (!objectIds.has(from)) add("error", "edge.from_missing", `边 ${rel} 的起点 ${from} 不存在`, `${from}->${to}`, graph);
    else if (objectGraph.get(from) !== graph) {
      add("error", "edge.from_graph_mismatch", `边 ${rel} 的起点 ${from} 属于图谱「${objectGraph.get(from)}」，不是「${graph}」`, `${from}->${to}`, graph);
    }
    if (!objectIds.has(to)) add("error", "edge.to_missing", `边 ${rel} 的终点 ${to} 不存在`, `${from}->${to}`, graph);
    else if (objectGraph.get(to) !== graph) {
      add("error", "edge.to_graph_mismatch", `边 ${rel} 的终点 ${to} 属于图谱「${objectGraph.get(to)}」，不是「${graph}」`, `${from}->${to}`, graph);
    }
    if (!String(e.evidence ?? "").trim()) add("warn", "edge.no_evidence", `边 ${rel} ${from} -> ${to} 没写 evidence`, `${from}->${to}`, graph);
    edgeByRelation.set(rel, (edgeByRelation.get(rel) ?? 0) + 1);
    touched.add(from);
    touched.add(to);
  }
  for (const r of relations) {
    if (!edgeByRelation.get(String(r.id))) {
      add("warn", "relation.no_edges", `关系 ${r.id} 没有任何实例边；map show/impact 看不到它`, String(r.id), relationGraph.get(String(r.id)));
    }
  }
  for (const o of objects) {
    if (!touched.has(String(o.id))) add("info", "object.isolated", `对象 ${o.id} 没有任何边`, String(o.id), objectGraph.get(String(o.id)));
  }

  // 重名 / 别名冲突：同图谱内 resolve 会返回多候选，容易挑错；跨图谱同名是正常分区
  const idsByName = new Map<string, Set<string>>();
  const idsByAlias = new Map<string, Set<string>>();
  for (const o of objects) {
    const graph = objectGraph.get(String(o.id)) ?? "default";
    const name = String(o.name ?? "").trim().toLowerCase();
    if (name) {
      const k = `${graph}\u0000${name}`;
      (idsByName.get(k) ?? idsByName.set(k, new Set()).get(k)!).add(String(o.id));
    }
    let aliases: unknown = o.aliases;
    try { aliases = JSON.parse(String(o.aliases ?? "[]")); } catch { aliases = []; }
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        const key = String(a ?? "").trim().toLowerCase();
        if (key) {
          const k = `${graph}\u0000${key}`;
          (idsByAlias.get(k) ?? idsByAlias.set(k, new Set()).get(k)!).add(String(o.id));
        }
      }
    }
  }
  for (const [name, ids] of idsByName) {
    if (ids.size > 1) add("warn", "object.duplicate_name", `图谱「${name.split("\u0000")[0]}」里名字「${name.split("\u0000")[1]}」被多个对象使用：${[...ids].join(", ")}`, undefined, name.split("\u0000")[0]);
  }
  for (const [alias, ids] of idsByAlias) {
    if (ids.size > 1) add("warn", "object.duplicate_alias", `图谱「${alias.split("\u0000")[0]}」里别名「${alias.split("\u0000")[1]}」指向多个对象：${[...ids].join(", ")}`, undefined, alias.split("\u0000")[0]);
  }

  for (const t of types) {
    if (!objects.some((o) => String(o.type) === String(t.id))) add("info", "type.empty", `类型 ${t.id} 没有对象`, String(t.id));
  }
  for (const a of actions) {
    let applies: unknown = a.applies_to;
    try { applies = JSON.parse(String(a.applies_to ?? "[]")); } catch { applies = []; }
    for (const t of Array.isArray(applies) ? applies : []) {
      if (!typeIds.has(String(t))) add("error", "action.type_missing", `动作 ${a.id} 的 appliesTo「${t}」没有声明`, String(a.id));
    }
    let req: unknown = a.requires_relations;
    try { req = JSON.parse(String(a.requires_relations ?? "[]")); } catch { req = []; }
    for (const r of Array.isArray(req) ? req : []) {
      if (!relationIds.has(String(r))) add("error", "action.relation_missing", `动作 ${a.id} 的 requiresRelations「${r}」不存在`, String(a.id));
    }
  }
  for (const t of terms) {
    if (!objectIds.has(String(t.object_id))) add("error", "term.object_missing", `术语「${t.term}」指向不存在的对象 ${t.object_id}`, String(t.term));
  }

  return makeReport(meta, counts, findings);
}

function reportFile(cfg: Config): string {
  return runtimePath(cfg, "business-lint.json");
}

export function writeBusinessLintReport(cfg: Config, report: BusinessLintReport): void {
  const file = reportFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readBusinessLintReport(cfg: Config): BusinessLintReport | null {
  try {
    const raw = JSON.parse(fs.readFileSync(reportFile(cfg), "utf8"));
    return raw && typeof raw === "object" ? raw as BusinessLintReport : null;
  } catch {
    return null;
  }
}
