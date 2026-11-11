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
}

export interface BusinessLintReport {
  checked_at: number;
  exists: boolean;
  version: number | null;
  counts: { types: number; objects: number; relations: number; edges: number; actions: number; terms: number };
  findings: BusinessLintFinding[];
  summary: { error: number; warn: number; info: number };
}

function makeReport(
  meta: Record<string, string>,
  counts: BusinessLintReport["counts"],
  findings: BusinessLintFinding[],
): BusinessLintReport {
  const summary = { error: 0, warn: 0, info: 0 };
  for (const f of findings) summary[f.level]++;
  return {
    checked_at: Date.now(),
    exists: !!meta.version || counts.objects > 0 || counts.relations > 0,
    version: meta.version ? Number(meta.version) : null,
    counts,
    findings,
    summary,
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
  const counts = {
    types: types.length, objects: objects.length, relations: relations.length,
    edges: edges.length, actions: actions.length, terms: terms.length,
  };
  const findings: BusinessLintFinding[] = [];
  const add = (level: LintLevel, code: string, message: string, ref?: string) =>
    findings.push({ level, code, message, ...(ref ? { ref } : {}) });

  const typeIds = new Set(types.map((t) => String(t.id)));
  const objectIds = new Set(objects.map((o) => String(o.id)));
  const relationIds = new Set(relations.map((r) => String(r.id)));

  if (!counts.objects && !counts.relations && !meta.version) {
    add("info", "map.empty", "还没有业务地图。先用 PUT /v1/business 写入对象和关系。");
    return makeReport(meta, counts, findings);
  }

  // 引用完整性（正常写入会校验，这里防旧库/手工改库）
  for (const o of objects) {
    if (!typeIds.has(String(o.type))) add("error", "object.type_missing", `对象 ${o.id} 的 type「${o.type}」没有声明`, String(o.id));
    if (!o.key_value) add("info", "object.no_key", `对象 ${o.id} 没有 key，后续去重/匹配只能靠 id/name`, String(o.id));
  }
  for (const r of relations) {
    if (!typeIds.has(String(r.from_type))) add("error", "relation.from_type_missing", `关系 ${r.id} 的 fromType「${r.from_type}」没有声明`, String(r.id));
    if (!typeIds.has(String(r.to_type))) add("error", "relation.to_type_missing", `关系 ${r.id} 的 toType「${r.to_type}」没有声明`, String(r.id));
    if (r.risk === "high" && !String(r.semantics ?? "").trim()) {
      add("warn", "relation.high_no_semantics", `高风险关系 ${r.id} 没写 semantics，impact 时说不清会影响什么`, String(r.id));
    }
    if (!r.cardinality) add("info", "relation.no_cardinality", `关系 ${r.id} 没写 cardinality`, String(r.id));
    if (!r.direction) add("info", "relation.no_direction", `关系 ${r.id} 没写 direction`, String(r.id));
  }
  const edgeByRelation = new Map<string, number>();
  const touched = new Set<string>();
  for (const e of edges) {
    const rel = String(e.relation_id);
    const from = String(e.from_id);
    const to = String(e.to_id);
    if (!relationIds.has(rel)) add("error", "edge.relation_missing", `边引用了不存在的关系 ${rel}`, `${from}->${to}`);
    if (!objectIds.has(from)) add("error", "edge.from_missing", `边 ${rel} 的起点 ${from} 不存在`, `${from}->${to}`);
    if (!objectIds.has(to)) add("error", "edge.to_missing", `边 ${rel} 的终点 ${to} 不存在`, `${from}->${to}`);
    if (!String(e.evidence ?? "").trim()) add("warn", "edge.no_evidence", `边 ${rel} ${from} -> ${to} 没写 evidence`, `${from}->${to}`);
    edgeByRelation.set(rel, (edgeByRelation.get(rel) ?? 0) + 1);
    touched.add(from);
    touched.add(to);
  }
  for (const r of relations) {
    if (!edgeByRelation.get(String(r.id))) {
      add("warn", "relation.no_edges", `关系 ${r.id} 没有任何实例边；map show/impact 看不到它`, String(r.id));
    }
  }
  for (const o of objects) {
    if (!touched.has(String(o.id))) add("info", "object.isolated", `对象 ${o.id} 没有任何边`, String(o.id));
  }

  // 重名 / 别名冲突：resolve 会返回多候选，容易挑错
  const idsByName = new Map<string, Set<string>>();
  const idsByAlias = new Map<string, Set<string>>();
  for (const o of objects) {
    const name = String(o.name ?? "").trim().toLowerCase();
    if (name) (idsByName.get(name) ?? idsByName.set(name, new Set()).get(name)!).add(String(o.id));
    let aliases: unknown = o.aliases;
    try { aliases = JSON.parse(String(o.aliases ?? "[]")); } catch { aliases = []; }
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        const key = String(a ?? "").trim().toLowerCase();
        if (key) (idsByAlias.get(key) ?? idsByAlias.set(key, new Set()).get(key)!).add(String(o.id));
      }
    }
  }
  for (const [name, ids] of idsByName) {
    if (ids.size > 1) add("warn", "object.duplicate_name", `名字「${name}」被多个对象使用：${[...ids].join(", ")}`);
  }
  for (const [alias, ids] of idsByAlias) {
    if (ids.size > 1) add("warn", "object.duplicate_alias", `别名「${alias}」指向多个对象：${[...ids].join(", ")}`);
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
