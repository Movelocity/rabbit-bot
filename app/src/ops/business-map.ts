/**
 * 业务地图：对象、关系、动作、术语的声明式模型。
 *
 * 关系实例默认不落库，按 mapping 在查询时算（manual 直接给边，file 读 JSON 再匹配）。
 * 地图是私有数据，只从 runtime/business 读；没有地图时所有 API 返回空，不影响主流程。
 */
import fs from "node:fs";
import path from "node:path";
import type { Store } from "../core/db.ts";
import { parseTaskContext } from "../core/tasks.ts";

export interface BusinessObjectType {
  id: string;
  name?: string;
  description?: string;
}

export interface BusinessObject {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
  description?: string;
  key?: { kind?: string; value: string };
  source?: { kind?: string; value: string };
  tags?: string[];
  graph_id: string;
  import_batch: string;
}

export type MappingKind = "manual" | "file";

export interface BusinessRelation {
  id: string;
  name: string;
  fromType: string;
  toType: string;
  kind?: MappingKind;
  mapping: {
    kind?: MappingKind;
    edges?: { from: string; to: string }[];
    file?: string;
    select?: string;
  };
  cardinality?: "1:1" | "1:N" | "N:1" | "N:N";
  direction?: "forward" | "both";
  risk?: "low" | "medium" | "high";
  semantics?: string;
  graph_id: string;
  import_batch: string;
}

export interface BusinessAction {
  id: string;
  name?: string;
  appliesTo?: string[];
  risk?: "low" | "medium" | "high";
  requiresRelations?: string[];
  description?: string;
}

export interface GlossaryTerm {
  term: string;
  objectId: string;
  note?: string;
}

export interface BusinessEdge {
  from: string;
  to: string;
  relation: string;
  graph_id: string;
  import_batch: string;
  evidence?: string | null;
}

export interface BusinessMap {
  dir: string;
  version: number;
  types: BusinessObjectType[];
  objects: BusinessObject[];
  relations: BusinessRelation[];
  actions: BusinessAction[];
  terms: GlossaryTerm[];
  byId: Map<string, BusinessObject>;
  typesById: Map<string, BusinessObjectType>;
  relationsById: Map<string, BusinessRelation>;
  edges: Map<string, BusinessEdge[]>;
}

export class BusinessMapError extends Error {}

export interface ResolveHit {
  object: BusinessObject;
  score: number;
  reason: string;
}

export interface Neighbor {
  relation: string;
  relationName: string;
  other: BusinessObject;
  direction: "out" | "in";
  risk?: string;
}

export interface ObjectView {
  object: BusinessObject;
  outgoing: Neighbor[];
  incoming: Neighbor[];
}

export interface ImpactHit {
  object: BusinessObject;
  relation: string;
  depth: number;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_OBJECTS = 2000;
const MAX_RELATIONS = 200;
const MAX_EDGES_PER_RELATION = 5000;
const MAX_RESOLVE = 10;
const MAX_NEIGHBORS = 20;
const MAX_PATH_DEPTH = 4;
const MAX_PATH_RESULTS = 5;
const MAX_PATH_STEPS = 2000;
const MAX_IMPACT_DEPTH = 3;
const MAX_IMPACT = 50;
const MAX_CONTEXT_LINES = 30;

const cache = new Map<string, { key: string; dataKey: string; map: BusinessMap }>();

function fail(file: string, message: string): never {
  throw new BusinessMapError(`${path.basename(file)}：${message}`);
}

function readJson(file: string, required: boolean): any {
  if (!fs.existsSync(file)) {
    if (required) throw new BusinessMapError(`缺少 ${file}`);
    return null;
  }
  const st = fs.statSync(file);
  if (st.size > MAX_FILE_BYTES) throw new BusinessMapError(`${path.basename(file)} 超过 ${MAX_FILE_BYTES} 字节`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new BusinessMapError(`${path.basename(file)} 不是合法 JSON：${(e as Error).message}`);
  }
}

function strList(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? "").trim()).filter(Boolean))].slice(0, max);
}

export const DEFAULT_GRAPH_ID = "default";
const MAX_GRAPH_ID_LEN = 100;
const MAX_IMPORT_BATCH_LEN = 100;

/** 图谱名：缺省/空白都落到默认图谱；超过长度直接报错，避免脏值进库。 */
function graphId(v: unknown, file: string, where: string): string {
  const raw = v === undefined || v === null ? "" : String(v).trim();
  if (raw.length > MAX_GRAPH_ID_LEN) fail(file, `${where} 的 graph_id 超过 ${MAX_GRAPH_ID_LEN} 字符`);
  return raw || DEFAULT_GRAPH_ID;
}

function importBatch(v: unknown, file: string, where: string): string {
  const raw = v === undefined || v === null ? "" : String(v).trim();
  if (raw.length > MAX_IMPORT_BATCH_LEN) fail(file, `${where} 的 import_batch 超过 ${MAX_IMPORT_BATCH_LEN} 字符`);
  return raw;
}

function slug(o: Pick<BusinessObject, "id" | "key" | "name">): string {
  const fromId = String(o.id ?? "").split(":").pop() ?? "";
  return fromId || String(o.key?.value ?? "").trim() || String(o.name ?? "").trim();
}

function normalizeTypes(raw: unknown, file: string): BusinessObjectType[] {
  if (!Array.isArray(raw)) fail(file, "types 要是数组");
  const out: BusinessObjectType[] = [];
  const seen = new Set<string>();
  for (const [i, x] of raw.entries()) {
    if (!x || typeof x !== "object") fail(file, `types[${i}] 要是对象`);
    const id = String((x as any).id ?? "").trim();
    if (!id) fail(file, `types[${i}].id 不能为空`);
    if (seen.has(id)) fail(file, `types 里 id 重复：${id}`);
    seen.add(id);
    out.push({
      id,
      name: (x as any).name === undefined ? undefined : String((x as any).name),
      description: (x as any).description === undefined ? undefined : String((x as any).description),
    });
  }
  return out;
}

function normalizeObjects(raw: unknown, file: string): BusinessObject[] {
  if (!Array.isArray(raw)) fail(file, "objects 要是数组");
  if (raw.length > MAX_OBJECTS) fail(file, `对象超过上限 ${MAX_OBJECTS}`);
  const out: BusinessObject[] = [];
  const seen = new Set<string>();
  for (const [i, x] of raw.entries()) {
    if (!x || typeof x !== "object") fail(file, `objects[${i}] 要是对象`);
    const id = String((x as any).id ?? "").trim();
    const type = String((x as any).type ?? "").trim();
    const name = String((x as any).name ?? "").trim();
    if (!id) fail(file, `objects[${i}].id 不能为空`);
    if (!type) fail(file, `objects[${i}].type 不能为空`);
    if (!name) fail(file, `objects[${i}].name 不能为空`);
    if (seen.has(id)) fail(file, `对象 id 重复：${id}`);
    seen.add(id);
    const key = (x as any).key;
    const source = (x as any).source;
    out.push({
      id, type, name,
      aliases: strList((x as any).aliases),
      description: (x as any).description === undefined ? undefined : String((x as any).description),
      key: key && typeof key === "object" ? { kind: key.kind === undefined ? undefined : String(key.kind), value: String(key.value ?? "") } : undefined,
      source: source && typeof source === "object" ? { kind: source.kind === undefined ? undefined : String(source.kind), value: String(source.value ?? "") } : undefined,
      tags: strList((x as any).tags),
      graph_id: graphId((x as any).graph_id ?? (x as any).graphId, file, `objects[${i}]`),
      import_batch: importBatch((x as any).import_batch ?? (x as any).importBatch, file, `objects[${i}]`),
    });
  }
  return out;
}

function normalizeRelations(raw: unknown, file: string): BusinessRelation[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) fail(file, "relations 要是数组");
  if (raw.length > MAX_RELATIONS) fail(file, `关系超过上限 ${MAX_RELATIONS}`);
  const out: BusinessRelation[] = [];
  const seen = new Set<string>();
  for (const [i, x] of raw.entries()) {
    if (!x || typeof x !== "object") fail(file, `relations[${i}] 要是对象`);
    const id = String((x as any).id ?? "").trim();
    const name = String((x as any).name ?? "").trim();
    const fromType = String((x as any).fromType ?? "").trim();
    const toType = String((x as any).toType ?? "").trim();
    if (!id) fail(file, `relations[${i}].id 不能为空`);
    if (!name) fail(file, `relations[${i}].name 不能为空`);
    if (!fromType) fail(file, `relations[${i}].fromType 不能为空`);
    if (!toType) fail(file, `relations[${i}].toType 不能为空`);
    if (seen.has(id)) fail(file, `关系 id 重复：${id}`);
    seen.add(id);
    const mapping = (x as any).mapping ?? {};
    const kind = String(mapping.kind ?? (x as any).kind ?? "manual").trim() as MappingKind;
    if (kind !== "manual" && kind !== "file") {
      fail(file, `relations[${i}].mapping.kind 只支持 manual / file（P0），收到 ${kind}`);
    }
    const normalized: BusinessRelation = {
      id, name, fromType, toType, kind,
      mapping: {
        kind,
        edges: Array.isArray(mapping.edges)
          ? mapping.edges.map((e: any) => ({ from: String(e?.from ?? "").trim(), to: String(e?.to ?? "").trim() })).filter((e: any) => e.from && e.to)
          : undefined,
        file: mapping.file === undefined ? undefined : String(mapping.file),
        select: mapping.select === undefined ? undefined : String(mapping.select),
      },
      cardinality: (x as any).cardinality === undefined ? undefined : String((x as any).cardinality) as any,
      direction: (x as any).direction === undefined ? "forward" : String((x as any).direction) as any,
      risk: (x as any).risk === undefined ? undefined : String((x as any).risk) as any,
      semantics: (x as any).semantics === undefined ? undefined : String((x as any).semantics),
      graph_id: graphId((x as any).graph_id ?? (x as any).graphId, file, `relations[${i}]`),
      import_batch: importBatch((x as any).import_batch ?? (x as any).importBatch, file, `relations[${i}]`),
    };
    if (normalized.cardinality && !["1:1", "1:N", "N:1", "N:N"].includes(normalized.cardinality)) {
      fail(file, `relations[${i}].cardinality 只能是 1:1 / 1:N / N:1 / N:N`);
    }
    if (normalized.direction !== "forward" && normalized.direction !== "both") {
      fail(file, `relations[${i}].direction 只能是 forward / both`);
    }
    if (kind === "manual" && !normalized.mapping.edges?.length) {
      fail(file, `relations[${i}] 是 manual，但没有 mapping.edges`);
    }
    if (kind === "file" && !normalized.mapping.file) {
      fail(file, `relations[${i}] 是 file，但没有 mapping.file`);
    }
    out.push(normalized);
  }
  return out;
}

function normalizeActions(raw: unknown, file: string): BusinessAction[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) fail(file, "actions 要是数组");
  return raw.map((x: any, i: number) => {
    const id = String(x?.id ?? "").trim();
    if (!id) fail(file, `actions[${i}].id 不能为空`);
    return {
      id,
      name: x?.name === undefined ? undefined : String(x.name),
      appliesTo: strList(x?.appliesTo),
      risk: x?.risk === undefined ? undefined : String(x.risk) as any,
      requiresRelations: strList(x?.requiresRelations),
      description: x?.description === undefined ? undefined : String(x.description),
    };
  });
}

function normalizeTerms(raw: unknown, file: string): GlossaryTerm[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) fail(file, "terms 要是数组");
  return raw.map((x: any, i: number) => {
    const term = String(x?.term ?? "").trim();
    const objectId = String(x?.objectId ?? "").trim();
    if (!term) fail(file, `terms[${i}].term 不能为空`);
    if (!objectId) fail(file, `terms[${i}].objectId 不能为空`);
    return { term, objectId, note: x?.note === undefined ? undefined : String(x.note) };
  });
}

function buildMap(dir: string): BusinessMap {
  const objectsFile = path.join(dir, "objects.json");
  const relationsFile = path.join(dir, "relations.json");
  const actionsFile = path.join(dir, "actions.json");
  const glossaryFile = path.join(dir, "glossary.json");

  const objectsDoc = readJson(objectsFile, true);
  const relationsDoc = readJson(relationsFile, false);
  const actionsDoc = readJson(actionsFile, false);
  const glossaryDoc = readJson(glossaryFile, false);

  if (!objectsDoc || typeof objectsDoc !== "object") fail(objectsFile, "顶层要是对象");
  const version = Number(objectsDoc.version ?? 1);
  if (version !== 1) fail(objectsFile, `不支持的 version：${objectsDoc.version}`);

  const types = normalizeTypes(objectsDoc.types ?? [], objectsFile);
  const objects = normalizeObjects(objectsDoc.objects ?? [], objectsFile);
  const relations = normalizeRelations(relationsDoc?.relations, relationsFile);
  const actions = normalizeActions(actionsDoc?.actions, actionsFile);
  const terms = normalizeTerms(glossaryDoc?.terms, glossaryFile);

  const typesById = new Map(types.map((t) => [t.id, t]));
  const byId = new Map(objects.map((o) => [o.id, o]));
  for (const o of objects) {
    if (!typesById.has(o.type)) fail(objectsFile, `对象 ${o.id} 的 type「${o.type}」没有在 types 里声明`);
  }
  const relationsById = new Map<string, BusinessRelation>();
  for (const r of relations) {
    if (!typesById.has(r.fromType)) fail(relationsFile, `关系 ${r.id} 的 fromType「${r.fromType}」没有声明`);
    if (!typesById.has(r.toType)) fail(relationsFile, `关系 ${r.id} 的 toType「${r.toType}」没有声明`);
    if (relationsById.has(r.id)) fail(relationsFile, `关系 id 重复：${r.id}`);
    relationsById.set(r.id, r);
    for (const e of r.mapping.edges ?? []) {
      if (!byId.has(e.from)) fail(relationsFile, `关系 ${r.id} 的边引用了不存在的对象：${e.from}`);
      if (!byId.has(e.to)) fail(relationsFile, `关系 ${r.id} 的边引用了不存在的对象：${e.to}`);
    }
  }
  for (const a of actions) {
    for (const t of a.appliesTo ?? []) {
      if (!typesById.has(t)) fail(actionsFile, `动作 ${a.id} 的 appliesTo 引用了不存在的类型：${t}`);
    }
    for (const rid of a.requiresRelations ?? []) {
      if (!relationsById.has(rid)) fail(actionsFile, `动作 ${a.id} 的 requiresRelations 引用了不存在的关系：${rid}`);
    }
  }
  for (const t of terms) {
    if (!byId.has(t.objectId)) fail(glossaryFile, `术语「${t.term}」指向不存在的对象：${t.objectId}`);
  }

  return {
    dir, version, types, objects, relations, actions, terms,
    byId, typesById, relationsById, edges: new Map(),
  };
}

function fileKey(dir: string): string {
  return ["objects.json", "relations.json", "actions.json", "glossary.json"].map((f) => {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  }).join("|");
}

function mappingDataKey(map: BusinessMap): string {
  const parts: string[] = [];
  for (const rel of map.relations) {
    if ((rel.mapping.kind ?? rel.kind) !== "file") continue;
    for (const target of map.objects.filter((o) => o.type === rel.toType)) {
      const file = expandTemplate(String(rel.mapping.file ?? ""), target);
      if (!file) continue;
      const abs = path.isAbsolute(file) ? file : path.join(map.dir, file);
      try {
        const st = fs.statSync(abs);
        parts.push(`${abs}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${abs}:-`);
      }
    }
  }
  return parts.join("|");
}

export function loadBusinessMapFromDir(dir: string): BusinessMap | null {
  if (!dir || !fs.existsSync(path.join(dir, "objects.json"))) {
    cache.delete(dir);
    return null;
  }
  const key = fileKey(dir);
  const hit = cache.get(dir);
  if (hit && hit.key === key) {
    const dataKey = mappingDataKey(hit.map);
    if (hit.dataKey === dataKey) return hit.map;
    // 关系定义没变、mapping 数据文件变了：只清边缓存，不重建对象索引
    hit.map.edges.clear();
    hit.dataKey = dataKey;
    return hit.map;
  }
  const map = buildMap(dir);
  cache.set(dir, { key, dataKey: mappingDataKey(map), map });
  return map;
}

function jsonList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  try {
    const parsed = JSON.parse(String(v ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 从 SQLite 拼出运行时的 BusinessMap。边已在库里物化，不再查文件。 */
function buildMapFromStore(store: Store): BusinessMap {
  const meta = store.businessMetaAll();
  const types: BusinessObjectType[] = store.listBusinessTypes().map((t) => ({
    id: String(t.id), name: t.name ?? "", description: t.description ?? "",
  }));
  const objects: BusinessObject[] = store.listBusinessObjects().map((o) => {
    const obj: BusinessObject = {
      id: String(o.id), type: String(o.type), name: String(o.name ?? ""),
      graph_id: String(o.graph_id ?? DEFAULT_GRAPH_ID), import_batch: String(o.import_batch ?? ""),
    };
    if (o.description) obj.description = String(o.description);
    if (o.key_value) obj.key = { ...(o.key_kind ? { kind: String(o.key_kind) } : {}), value: String(o.key_value) };
    if (o.source_value) obj.source = { ...(o.source_kind ? { kind: String(o.source_kind) } : {}), value: String(o.source_value) };
    const aliases = jsonList(o.aliases);
    if (aliases.length) obj.aliases = aliases;
    const tags = jsonList(o.tags);
    if (tags.length) obj.tags = tags;
    return obj;
  });
  const relations: BusinessRelation[] = store.listBusinessRelations().map((r) => ({
    id: String(r.id), name: String(r.name ?? ""), fromType: String(r.from_type), toType: String(r.to_type),
    ...(r.cardinality ? { cardinality: r.cardinality } : {}),
    ...(r.direction ? { direction: r.direction } : {}),
    ...(r.risk ? { risk: r.risk } : {}),
    ...(r.semantics ? { semantics: r.semantics } : {}),
    kind: "manual", mapping: { kind: "manual" },
    graph_id: String(r.graph_id ?? DEFAULT_GRAPH_ID), import_batch: String(r.import_batch ?? ""),
  } as BusinessRelation));
  const actions: BusinessAction[] = store.listBusinessActions().map((a) => ({
    id: String(a.id), name: a.name ?? "",
    ...(jsonList(a.applies_to).length ? { appliesTo: jsonList(a.applies_to) } : {}),
    ...(a.risk ? { risk: a.risk } : {}),
    ...(jsonList(a.requires_relations).length ? { requiresRelations: jsonList(a.requires_relations) } : {}),
    ...(a.description ? { description: String(a.description) } : {}),
  } as BusinessAction));
  const terms: GlossaryTerm[] = store.listBusinessTerms().map((t) => ({
    term: String(t.term), objectId: String(t.object_id), ...(t.note ? { note: String(t.note) } : {}),
  }));

  const byId = new Map(objects.map((o) => [o.id, o]));
  const typesById = new Map(types.map((t) => [t.id, t]));
  const relationsById = new Map(relations.map((r) => [r.id, r]));
  const edges = new Map<string, BusinessEdge[]>(relations.map((r) => [r.id, []]));
  for (const e of store.listBusinessEdges()) {
    const list = edges.get(String(e.relation_id));
    if (!list) continue;
    list.push({
      from: String(e.from_id), to: String(e.to_id), relation: String(e.relation_id),
      graph_id: String(e.graph_id ?? DEFAULT_GRAPH_ID), import_batch: String(e.import_batch ?? ""),
      evidence: e.evidence == null ? null : String(e.evidence),
    });
  }
  return {
    dir: meta.dir ?? "", version: Number(meta.version ?? 1),
    types, objects, relations, actions, terms, byId, typesById, relationsById, edges,
  };
}

/** 运行时唯一的读取入口：没有地图（无 version 且无对象）返回 null。 */
export function loadBusinessMap(store: Store): BusinessMap | null {
  const meta = store.businessMetaAll();
  if (!meta.version && store.listBusinessObjects().length === 0 && store.listBusinessRelations().length === 0) return null;
  return buildMapFromStore(store);
}

/**
 * 把 runtime/business 的旧文件一次性导入 SQLite。
 * 关系实例（含 file mapping 算出来的边）在导入时就物化，之后运行时不再读文件。
 */
export function importBusinessMap(store: Store, dir: string): BusinessMap | null {
  const map = loadBusinessMapFromDir(dir);
  if (!map) return null;
  const edges = map.relations.flatMap((r) => relationEdges(map, r.id).map((e) => ({
    relation: e.relation, from: e.from, to: e.to,
    graph_id: e.graph_id, import_batch: e.import_batch,
  })));
  store.replaceBusinessMap({
    version: map.version, types: map.types, objects: map.objects, relations: map.relations,
    edges, actions: map.actions, terms: map.terms,
  });
  store.setBusinessMeta("dir", map.dir);
  store.setBusinessMeta("imported_from", map.dir);
  return loadBusinessMap(store);
}

/** 启动时调用：库里已经有地图就不动；没有且目录里有 objects.json 才导一次。 */
export function ensureBusinessSeeded(store: Store, dir: string): BusinessMap | null {
  const meta = store.businessMetaAll();
  if (meta.version || store.listBusinessObjects().length) return null;
  if (!dir || !fs.existsSync(path.join(dir, "objects.json"))) return null;
  return importBusinessMap(store, dir);
}

/** 当前地图的可写快照：PUT /v1/business 的返回体，也是 GET 的来源。 */
export function businessSnapshot(store: Store) {
  const map = loadBusinessMap(store);
  if (!map) return null;
  return {
    version: map.version,
    types: map.types,
    objects: map.objects,
    relations: map.relations.map((r) => ({
      id: r.id, name: r.name, fromType: r.fromType, toType: r.toType,
      cardinality: r.cardinality, direction: r.direction, risk: r.risk, semantics: r.semantics,
      graph_id: r.graph_id, import_batch: r.import_batch,
    })),
    edges: [...map.edges.values()].flat().map((e) => ({
      relation: e.relation, from: e.from, to: e.to, graph_id: e.graph_id, import_batch: e.import_batch,
      evidence: e.evidence ?? null,
    })),
    actions: map.actions,
    terms: map.terms,
  };
}

/** 全量替换：API 写入的唯一入口。校验不过直接抛 BusinessMapError，库里保持原样。 */
export function replaceBusinessMap(store: Store, raw: unknown) {
  const data = validateSnapshot(raw);
  store.replaceBusinessMap(data);
  return businessSnapshot(store);
}

function validateSnapshot(raw: unknown): Parameters<Store["replaceBusinessMap"]>[0] {
  if (!raw || typeof raw !== "object") throw new BusinessMapError("快照要是一个对象");
  const x = raw as any;
  const version = Number(x.version ?? 1);
  if (!Number.isInteger(version) || version <= 0) throw new BusinessMapError("version 要是正整数");

  const arr = (v: unknown, name: string): any[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new BusinessMapError(`${name} 要是数组`);
    return v;
  };
  const graphOf = (v: unknown, where: string, fallback = DEFAULT_GRAPH_ID): string => {
    const raw = v === undefined || v === null ? "" : String(v).trim();
    if (raw.length > MAX_GRAPH_ID_LEN) throw new BusinessMapError(`${where} 的 graph_id 超过 ${MAX_GRAPH_ID_LEN} 字符`);
    return raw || fallback;
  };
  const batchOf = (v: unknown, where: string, fallback = ""): string => {
    const raw = v === undefined || v === null ? "" : String(v).trim();
    if (raw.length > MAX_IMPORT_BATCH_LEN) throw new BusinessMapError(`${where} 的 import_batch 超过 ${MAX_IMPORT_BATCH_LEN} 字符`);
    return raw || fallback;
  };
  const types = arr(x.types, "types").map((t, i) => {
    const id = String(t?.id ?? "").trim();
    if (!id) throw new BusinessMapError(`types[${i}].id 不能为空`);
    return { id, name: String(t?.name ?? ""), description: String(t?.description ?? "") };
  });
  const typeIds = new Set(types.map((t) => t.id));
  if (typeIds.size !== types.length) throw new BusinessMapError("types 里 id 重复");

  const objects = arr(x.objects, "objects").map((o, i) => {
    const id = String(o?.id ?? "").trim();
    const type = String(o?.type ?? "").trim();
    if (!id) throw new BusinessMapError(`objects[${i}].id 不能为空`);
    if (!type) throw new BusinessMapError(`objects[${i}].type 不能为空`);
    if (!typeIds.has(type)) throw new BusinessMapError(`对象 ${id} 的 type「${type}」没有在 types 里声明`);
    const key = o?.key && typeof o.key === "object" ? { kind: o.key.kind ? String(o.key.kind) : undefined, value: String(o.key.value ?? "") } : null;
    if (key && !key.value) throw new BusinessMapError(`对象 ${id} 的 key.value 不能为空`);
    const source = o?.source && typeof o.source === "object" ? { kind: o.source.kind ? String(o.source.kind) : undefined, value: String(o.source.value ?? "") } : null;
    if (source && !source.value) throw new BusinessMapError(`对象 ${id} 的 source.value 不能为空`);
    return {
      id, type, name: String(o?.name ?? ""), description: String(o?.description ?? ""), key, source,
      aliases: jsonList(o?.aliases), tags: jsonList(o?.tags),
      graph_id: graphOf(o?.graph_id ?? o?.graphId, `objects[${i}]`),
      import_batch: batchOf(o?.import_batch ?? o?.importBatch, `objects[${i}]`),
    };
  });
  const objectIds = new Set(objects.map((o) => o.id));
  if (objectIds.size !== objects.length) throw new BusinessMapError("objects 里 id 重复");
  const objectGraph = new Map(objects.map((o) => [o.id, o.graph_id]));

  const relations = arr(x.relations, "relations").map((r, i) => {
    const id = String(r?.id ?? "").trim();
    if (!id) throw new BusinessMapError(`relations[${i}].id 不能为空`);
    const fromType = String(r?.fromType ?? "").trim();
    const toType = String(r?.toType ?? "").trim();
    if (!typeIds.has(fromType)) throw new BusinessMapError(`关系 ${id} 的 fromType「${fromType}」没有声明`);
    if (!typeIds.has(toType)) throw new BusinessMapError(`关系 ${id} 的 toType「${toType}」没有声明`);
    const cardinality = r?.cardinality ? String(r.cardinality) : undefined;
    if (cardinality && !["1:1", "1:N", "N:1", "N:N"].includes(cardinality)) throw new BusinessMapError(`关系 ${id} 的 cardinality 不合法`);
    const direction = r?.direction ? String(r.direction) : undefined;
    if (direction && !["forward", "both"].includes(direction)) throw new BusinessMapError(`关系 ${id} 的 direction 不合法`);
    const risk = r?.risk ? String(r.risk) : undefined;
    if (risk && !["low", "medium", "high"].includes(risk)) throw new BusinessMapError(`关系 ${id} 的 risk 不合法`);
    return {
      id, name: String(r?.name ?? ""), fromType, toType, cardinality, direction, risk,
      semantics: r?.semantics ? String(r.semantics) : undefined,
      graph_id: graphOf(r?.graph_id ?? r?.graphId, `relations[${i}]`),
      import_batch: batchOf(r?.import_batch ?? r?.importBatch, `relations[${i}]`),
    };
  });
  const relationIds = new Set(relations.map((r) => r.id));
  if (relationIds.size !== relations.length) throw new BusinessMapError("relations 里 id 重复");
  const relationById = new Map(relations.map((r) => [r.id, r]));

  const seenEdge = new Set<string>();
  const edges = arr(x.edges, "edges").map((e, i) => {
    const relation = String(e?.relation ?? "").trim();
    const from = String(e?.from ?? "").trim();
    const to = String(e?.to ?? "").trim();
    const rel = relationById.get(relation);
    if (!rel) throw new BusinessMapError(`edges[${i}] 的 relation「${relation}」不存在`);
    if (!objectIds.has(from)) throw new BusinessMapError(`edges[${i}] 的 from「${from}」不存在`);
    if (!objectIds.has(to)) throw new BusinessMapError(`edges[${i}] 的 to「${to}」不存在`);
    const graph = graphOf(e?.graph_id ?? e?.graphId, `edges[${i}]`, rel.graph_id);
    if (graph !== rel.graph_id) {
      throw new BusinessMapError(`edges[${i}] 的 graph_id「${graph}」和关系 ${relation} 的「${rel.graph_id}」不一致`);
    }
    if (objectGraph.get(from) !== graph) {
      throw new BusinessMapError(`edges[${i}] 的 from「${from}」属于图谱「${objectGraph.get(from)}」，不是「${graph}」`);
    }
    if (objectGraph.get(to) !== graph) {
      throw new BusinessMapError(`edges[${i}] 的 to「${to}」属于图谱「${objectGraph.get(to)}」，不是「${graph}」`);
    }
    const k = `${relation}|${from}|${to}`;
    if (seenEdge.has(k)) throw new BusinessMapError(`edges 重复：${k}`);
    seenEdge.add(k);
    return {
      relation, from, to, evidence: e?.evidence ? String(e.evidence) : null,
      graph_id: graph, import_batch: batchOf(e?.import_batch ?? e?.importBatch, `edges[${i}]`, rel.import_batch),
    };
  });

  const actions = arr(x.actions, "actions").map((a, i) => {
    const id = String(a?.id ?? "").trim();
    if (!id) throw new BusinessMapError(`actions[${i}].id 不能为空`);
    const appliesTo = jsonList(a?.appliesTo);
    for (const t of appliesTo) if (!typeIds.has(t)) throw new BusinessMapError(`动作 ${id} 的 appliesTo「${t}」没有声明`);
    const requiresRelations = jsonList(a?.requiresRelations);
    for (const r of requiresRelations) if (!relationIds.has(r)) throw new BusinessMapError(`动作 ${id} 的 requiresRelations「${r}」不存在`);
    const risk = a?.risk ? String(a.risk) : undefined;
    if (risk && !["low", "medium", "high"].includes(risk)) throw new BusinessMapError(`动作 ${id} 的 risk 不合法`);
    return { id, name: String(a?.name ?? ""), appliesTo, risk, requiresRelations, description: String(a?.description ?? "") };
  });
  if (new Set(actions.map((a) => a.id)).size !== actions.length) throw new BusinessMapError("actions 里 id 重复");

  const terms = arr(x.terms, "terms").map((t, i) => {
    const term = String(t?.term ?? "").trim();
    const objectId = String(t?.objectId ?? "").trim();
    if (!term) throw new BusinessMapError(`terms[${i}].term 不能为空`);
    if (!objectIds.has(objectId)) throw new BusinessMapError(`术语「${term}」指向不存在的对象：${objectId}`);
    return { term, objectId, note: String(t?.note ?? "") };
  });

  return { version, types, objects, relations, edges, actions, terms };
}

function expandTemplate(tmpl: string, obj: BusinessObject): string {
  return tmpl.replace(/\{(\w+)\}/g, (_m, k: string) => {
    if (k === "id") return obj.id;
    if (k === "type") return obj.type;
    if (k === "name") return obj.name;
    if (k === "slug") return slug(obj);
    if (k === "key") return String(obj.key?.value ?? slug(obj));
    return String(obj.key?.value ?? obj.name ?? slug(obj));
  });
}

function toValue(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v && typeof v === "object") return String((v as any).id ?? (v as any).key ?? (v as any).name ?? "").trim();
  return "";
}

function selectValues(data: any, select?: string): string[] {
  if (!select) {
    return Array.isArray(data) ? data.map(toValue).filter(Boolean) : [];
  }
  let cur = data;
  for (const part of select.split(".")) {
    const name = part.replace(/\[\]$/, "");
    if (cur === null || cur === undefined) return [];
    cur = cur[name];
  }
  if (!Array.isArray(cur)) return [];
  return [...new Set(cur.map(toValue).filter(Boolean))];
}

function matchObject(objects: BusinessObject[], value: string): BusinessObject | undefined {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return undefined;
  return objects.find((o) => [o.id, o.key?.value, o.name, slug(o), ...(o.aliases ?? [])]
    .some((x) => String(x ?? "").trim().toLowerCase() === v));
}

function computeEdges(map: BusinessMap, rel: BusinessRelation): BusinessEdge[] {
  const cached = map.edges.get(rel.id);
  if (cached) return cached;

  const out: BusinessEdge[] = [];
  const kind = rel.mapping.kind ?? rel.kind ?? "manual";
  if (kind === "manual") {
    for (const e of rel.mapping.edges ?? []) {
      if (!map.byId.has(e.from) || !map.byId.has(e.to)) continue;
      out.push({
        from: e.from, to: e.to, relation: rel.id,
        graph_id: rel.graph_id, import_batch: rel.import_batch,
      });
      if (out.length >= MAX_EDGES_PER_RELATION) break;
    }
  } else {
    const sources = map.objects.filter((o) => o.type === rel.fromType);
    const targets = map.objects.filter((o) => o.type === rel.toType);
    for (const target of targets) {
      const file = expandTemplate(String(rel.mapping.file ?? ""), target);
      if (!file) continue;
      const abs = path.isAbsolute(file) ? file : path.join(map.dir, file);
      let data: any;
      try {
        data = JSON.parse(fs.readFileSync(abs, "utf8"));
      } catch {
        continue;
      }
      for (const value of selectValues(data, rel.mapping.select)) {
        const from = matchObject(sources, value);
        if (!from) continue;
        out.push({
          from: from.id, to: target.id, relation: rel.id,
          graph_id: rel.graph_id, import_batch: rel.import_batch,
        });
        if (out.length >= MAX_EDGES_PER_RELATION) break;
      }
      if (out.length >= MAX_EDGES_PER_RELATION) break;
    }
  }
  map.edges.set(rel.id, out);
  return out;
}

/** 关系解析后的实际边：manual 用声明里的 edges，file 按 mapping 读数据文件。 */
export function relationEdges(map: BusinessMap, relationId: string): BusinessEdge[] {
  const rel = map.relationsById.get(relationId);
  return rel ? computeEdges(map, rel) : [];
}

function outEdges(map: BusinessMap, id: string): BusinessEdge[] {
  const out: BusinessEdge[] = [];
  for (const rel of map.relations) {
    const both = rel.direction === "both";
    for (const e of computeEdges(map, rel)) {
      if (e.from === id) out.push(e);
      else if (both && e.to === id) out.push({
        from: id, to: e.from, relation: rel.id,
        graph_id: e.graph_id, import_batch: e.import_batch,
      });
    }
  }
  return out;
}

function inEdges(map: BusinessMap, id: string): BusinessEdge[] {
  const out: BusinessEdge[] = [];
  for (const rel of map.relations) {
    const both = rel.direction === "both";
    for (const e of computeEdges(map, rel)) {
      if (e.to === id) out.push(e);
      else if (both && e.from === id) out.push({
        from: e.to, to: id, relation: rel.id,
        graph_id: e.graph_id, import_batch: e.import_batch,
      });
    }
  }
  return out;
}

export function indexLine(map: BusinessMap): string {
  return `业务地图：${map.types.length} 类对象 / ${map.relations.length} 条关系 / ${map.objects.length} 个对象。`
    + "要查对象、关系路径或影响面，先用 map 工具（index / show / resolve / path / impact）。";
}

export function businessIndexLine(store: Store): string {
  try {
    const map = loadBusinessMap(store);
    return map ? indexLine(map) : "";
  } catch {
    return "";
  }
}

/** 兼容直接传目录的调用方（测试/迁移）；正式路径走 businessIndexLine(store)。 */
export function businessIndexLineFromDir(dir: string): string {
  try {
    const map = loadBusinessMapFromDir(dir);
    return map ? indexLine(map) : "";
  } catch {
    return "";
  }
}

export function renderIndex(map: BusinessMap): string {
  const counts = new Map<string, number>();
  for (const o of map.objects) counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
  const typeLine = map.types
    .map((t) => `${t.id}(${counts.get(t.id) ?? 0})`)
    .join(" ");
  const relLine = map.relations
    .map((r) => `${r.id} ${r.fromType}→${r.toType}${r.risk === "high" ? " [high]" : ""}`)
    .join("；");
  return [
    `业务地图 v${map.version}：${map.types.length} 类对象 / ${map.relations.length} 条关系 / ${map.objects.length} 个对象`,
    `对象：${typeLine || "（没有）"}`,
    `关系：${relLine || "（没有）"}`,
  ].join("\n");
}

export function resolveObjects(map: BusinessMap, term: string): ResolveHit[] {
  const q = String(term ?? "").trim().toLowerCase();
  if (!q) return [];
  const hits = new Map<string, ResolveHit>();
  const add = (object: BusinessObject, score: number, reason: string) => {
    const prev = hits.get(object.id);
    if (!prev || prev.score < score) hits.set(object.id, { object, score, reason });
  };

  for (const o of map.objects) {
    const exact = [o.id, o.key?.value, o.name, slug(o), ...(o.aliases ?? [])]
      .some((x) => String(x ?? "").trim().toLowerCase() === q);
    if (exact) add(o, 100, "精确匹配");
  }
  for (const t of map.terms) {
    if (t.term.trim().toLowerCase() !== q) continue;
    const o = map.byId.get(t.objectId);
    if (o) add(o, 95, `术语「${t.term}」`);
  }
  for (const o of map.objects) {
    const hay = [o.name, o.description, ...(o.aliases ?? []), ...(o.tags ?? [])].join(" ").toLowerCase();
    if (hay.includes(q)) add(o, 60, "名称/描述包含");
  }

  return [...hits.values()].sort((a, b) => b.score - a.score || a.object.id.localeCompare(b.object.id)).slice(0, MAX_RESOLVE);
}

export function showObject(map: BusinessMap, id: string): ObjectView | null {
  const object = map.byId.get(id);
  if (!object) return null;
  const seen = new Set<string>();
  const outgoing: Neighbor[] = [];
  for (const e of outEdges(map, id)) {
    const other = map.byId.get(e.to);
    if (!other) continue;
    const key = `out|${e.relation}|${other.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = map.relationsById.get(e.relation);
    outgoing.push({ relation: e.relation, relationName: rel?.name ?? e.relation, other, direction: "out", risk: rel?.risk });
    if (outgoing.length >= MAX_NEIGHBORS) break;
  }
  const incoming: Neighbor[] = [];
  for (const e of inEdges(map, id)) {
    const other = map.byId.get(e.from);
    if (!other) continue;
    const key = `in|${e.relation}|${other.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = map.relationsById.get(e.relation);
    incoming.push({ relation: e.relation, relationName: rel?.name ?? e.relation, other, direction: "in", risk: rel?.risk });
    if (incoming.length >= MAX_NEIGHBORS) break;
  }
  return { object, outgoing, incoming };
}

export function findPaths(map: BusinessMap, from: string, to: string, maxDepth = MAX_PATH_DEPTH): BusinessEdge[][] {
  if (!map.byId.has(from) || !map.byId.has(to) || from === to) return [];
  const depth = Math.max(1, Math.min(MAX_PATH_DEPTH, Math.floor(maxDepth)));
  const results: BusinessEdge[][] = [];
  let steps = 0;

  const dfs = (node: string, trail: BusinessEdge[], visited: Set<string>) => {
    if (results.length >= MAX_PATH_RESULTS || steps >= MAX_PATH_STEPS) return;
    if (trail.length >= depth) return;
    for (const e of outEdges(map, node)) {
      if (++steps >= MAX_PATH_STEPS) return;
      if (visited.has(e.to)) continue;
      const next = [...trail, e];
      if (e.to === to) {
        results.push(next);
        if (results.length >= MAX_PATH_RESULTS) return;
        continue;
      }
      visited.add(e.to);
      dfs(e.to, next, visited);
      visited.delete(e.to);
    }
  };

  dfs(from, [], new Set([from]));
  return results;
}

export function impactOf(map: BusinessMap, id: string, maxDepth = MAX_IMPACT_DEPTH): ImpactHit[] {
  if (!map.byId.has(id)) return [];
  const depth = Math.max(1, Math.min(MAX_IMPACT_DEPTH, Math.floor(maxDepth)));
  const out: ImpactHit[] = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of inEdges(map, cur)) {
        if (seen.has(e.from)) continue;
        const object = map.byId.get(e.from);
        if (!object) continue;
        seen.add(e.from);
        out.push({ object, relation: e.relation, depth: d });
        next.push(e.from);
        if (out.length >= MAX_IMPACT) return out;
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return out;
}

function edgeLabel(map: BusinessMap, e: BusinessEdge): string {
  const rel = map.relationsById.get(e.relation);
  return `${e.from} --${rel?.name ?? e.relation}--> ${e.to}`;
}

function objectLabel(o: BusinessObject): string {
  return `${o.id}（${o.name}，${o.type}）`;
}

export function renderTaskContext(map: BusinessMap, raw: string | null | undefined): string {
  const ctx = parseTaskContext(raw);
  if (!ctx.objects.length && !ctx.relations.length && !ctx.forbidden.length) return "";

  const lines: string[] = ["## 业务上下文", ""];
  const known = ctx.objects.map((id) => map.byId.get(id)).filter((o): o is BusinessObject => !!o);
  const unknowns = ctx.objects.filter((id) => !map.byId.has(id));

  if (ctx.objects.length) {
    lines.push(`- 对象：${[...known.map(objectLabel), ...unknowns.map((id) => `${id}（地图里没有）`)].join("；")}`);
  }

  for (const rid of ctx.relations) {
    const rel = map.relationsById.get(rid);
    if (!rel) {
      lines.push(`- 关系 ${rid}（地图里没有）`);
      continue;
    }
    const ids = new Set(ctx.objects);
    const edges = computeEdges(map, rel).filter((e) => !ids.size || ids.has(e.from) || ids.has(e.to)).slice(0, 5);
    if (edges.length) {
      lines.push(`- 关系 ${rid}（${rel.fromType}→${rel.toType}）：${edges.map((e) => edgeLabel(map, e)).join("；")}`);
    } else {
      lines.push(`- 关系 ${rid}（${rel.fromType}→${rel.toType}）：${rel.semantics ?? "（没有可展示的实例）"}`);
    }
  }

  if (!ctx.relations.length && ctx.objects.length) {
    const ids = new Set(ctx.objects);
    const edges = map.relations
      .flatMap((r) => computeEdges(map, r))
      .filter((e) => ids.has(e.from) || ids.has(e.to))
      .slice(0, 8);
    if (edges.length) lines.push(`- 相关关系：${edges.map((e) => edgeLabel(map, e)).join("；")}`);
  }

  if (ctx.forbidden.length) {
    const names = ctx.forbidden.map((id) => {
      const o = map.byId.get(id);
      if (o) return objectLabel(o);
      const r = map.relationsById.get(id);
      return r ? `${id}（关系）` : `${id}（地图里没有）`;
    });
    lines.push(`- 禁止：${names.join("；")}`);
  }

  const impacts: string[] = [];
  for (const o of known) {
    for (const hit of impactOf(map, o.id, 2).slice(0, 3)) {
      impacts.push(`改 ${o.id} 会影响 ${hit.object.id}（${hit.object.name}）`);
    }
  }
  if (impacts.length) lines.push(`- 影响面：${[...new Set(impacts)].slice(0, 5).join("；")}`);

  const actions = map.actions.filter((a) => (a.appliesTo ?? []).some((t) => known.some((o) => o.type === t)));
  if (actions.length) {
    lines.push(`- 可用动作：${actions.slice(0, 5).map((a) => `${a.id}（${a.risk ?? "low"}${a.description ? `，${a.description}` : ""}）`).join("；")}`);
  }

  if (lines.length > MAX_CONTEXT_LINES) {
    const rest = lines.length - MAX_CONTEXT_LINES;
    lines.length = MAX_CONTEXT_LINES;
    lines.push(`- （还有 ${rest} 行未列出）`);
  }
  return lines.join("\n");
}

/** 给任务文档用：地图读失败就静默跳过，不能让坏地图挡住派活。 */
export function renderTaskContextFromDir(dir: string | undefined, raw: string | null | undefined): string {
  if (!dir) return "";
  try {
    const map = loadBusinessMapFromDir(dir);
    return map ? renderTaskContext(map, raw) : "";
  } catch {
    return "";
  }
}

export function formatPath(map: BusinessMap, path: BusinessEdge[]): string {
  const nodes = [path[0]?.from, ...path.map((e) => e.to)];
  return nodes.map((n) => n ?? "?").join(" → ") + "（" + path.map((e) => map.relationsById.get(e.relation)?.name ?? e.relation).join(", ") + "）";
}
