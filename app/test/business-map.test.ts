/** 业务地图：SQLite 存取、导入、校验、解析、路径、影响面、任务上下文。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { createTask, getTask } from "../src/core/tasks.ts";
import { renderTaskDoc, writeTaskDoc } from "../src/core/dispatch.ts";
import { createTools } from "../src/agent/tools.ts";
import { systemPrompt } from "../src/agent/prompt.ts";
import {
  BusinessMapError, businessIndexLine, businessSnapshot, ensureBusinessSeeded, findPaths, impactOf,
  importBusinessMap, loadBusinessMap, loadBusinessMapFromDir, renderIndex, renderTaskContext,
  replaceBusinessMap, resolveObjects, showObject,
} from "../src/ops/business-map.ts";

const EXAMPLES = path.resolve(import.meta.dirname, "../../docs/examples/business");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-biz-"));
  const dir = path.join(root, "business");
  fs.cpSync(EXAMPLES, dir, { recursive: true });
  const cfg = loadConfig({ runtimeDir: root, exec: { dir: path.join(root, "sandbox") } });
  const store = new Store(":memory:");
  importBusinessMap(store, dir);
  return { root, dir, cfg, store };
}

function cleanup(x: { root: string; store?: Store }) {
  x.store?.close();
  fs.rmSync(x.root, { recursive: true, force: true });
}

function textOf(r: any): string {
  return (r.content ?? []).map((c: any) => c?.text ?? "").join("");
}

function writeBad(dir: string, objects: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "objects.json"), JSON.stringify(objects), "utf8");
}

test("没有 objects.json 时返回 null，不报错", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-biz-empty-"));
  assert.equal(loadBusinessMapFromDir(path.join(root, "business")), null);
  const store = new Store(":memory:");
  assert.equal(loadBusinessMap(store), null);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("导入示例地图：类型/关系/对象数量正确", () => {
  const x = setup();
  const map = loadBusinessMap(x.store)!;
  assert.ok(map);
  assert.equal(map.types.length, 5);
  assert.equal(map.relations.length, 4);
  assert.equal(map.objects.length, 7);
  assert.match(renderIndex(map), /business|project/);
  assert.match(renderIndex(map), /service_deploys_to_env/);
  assert.equal(loadBusinessMapFromDir(x.dir)!.objects.length, 7);
  cleanup(x);
});

test("resolve：精确、别名、术语、词法", () => {
  const x = setup();
  const map = loadBusinessMap(x.store)!;
  assert.equal(resolveObjects(map, "service:rabbit-bot-admin")[0].object.id, "service:rabbit-bot-admin");
  assert.equal(resolveObjects(map, "管理后台")[0].object.id, "service:rabbit-bot-admin");
  assert.equal(resolveObjects(map, "老地方")[0].object.id, "env:prod");
  assert.ok(resolveObjects(map, "个人 IM").some((h) => h.object.id === "project:rabbit-bot"));
  assert.equal(resolveObjects(map, "完全不存在").length, 0);
  cleanup(x);
});

test("show：对象卡片带出直接关系", () => {
  const x = setup();
  const map = loadBusinessMap(x.store)!;
  const view = showObject(map, "service:rabbit-bot-api")!;
  assert.ok(view);
  assert.equal(view.object.name, "api");
  assert.ok(view.outgoing.some((n) => n.relation === "service_deploys_to_env" && n.other.id === "env:prod"));
  assert.ok(view.outgoing.some((n) => n.relation === "service_deploys_to_env" && n.other.id === "env:staging"));
  assert.ok(view.outgoing.some((n) => n.relation === "service_belongs_to_project" && n.other.id === "project:rabbit-bot"));
  cleanup(x);
});

test("path / impact：导入时把 file mapping 的边物化到库里", () => {
  const x = setup();
  const map = loadBusinessMap(x.store)!;
  const paths = findPaths(map, "service:rabbit-bot-admin", "env:prod");
  assert.equal(paths.length, 1);
  assert.equal(paths[0][0].relation, "service_deploys_to_env");

  const prod = impactOf(map, "env:prod").map((h) => h.object.id).sort();
  assert.deepEqual(prod, ["service:rabbit-bot-admin", "service:rabbit-bot-api"]);

  const project = impactOf(map, "project:rabbit-bot").map((h) => h.object.id).sort();
  assert.deepEqual(project, ["person:viking", "repo:rabbit-bot", "service:rabbit-bot-admin", "service:rabbit-bot-api"]);

  assert.deepEqual(findPaths(map, "service:rabbit-bot-admin", "person:viking"), [], "不做传递闭包");
  // 边是库里的行，不再依赖 deploy 文件
  assert.ok(x.store.listBusinessEdges().some((e) => e.relation_id === "service_deploys_to_env"));
  cleanup(x);
});

test("改 deploy 文件后重新导入能看到新边", () => {
  const x = setup();
  assert.ok(findPaths(loadBusinessMap(x.store)!, "service:rabbit-bot-admin", "env:prod").length);
  fs.writeFileSync(path.join(x.dir, "deploy/prod.json"), '{"services":["rabbit-bot-api"]}', "utf8");
  importBusinessMap(x.store, x.dir);
  const after = loadBusinessMap(x.store)!;
  assert.equal(findPaths(after, "service:rabbit-bot-admin", "env:prod").length, 0);
  assert.ok(findPaths(after, "service:rabbit-bot-api", "env:prod").length);
  cleanup(x);
});

test("校验：未知 type、重复 id、坏 JSON 都报清楚", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-biz-bad-"));
  const dir = path.join(root, "business");
  writeBad(dir, {
    version: 1,
    types: [{ id: "project" }],
    objects: [{ id: "project:x", type: "nope", name: "x" }],
  });
  assert.throws(() => loadBusinessMapFromDir(dir), (e: unknown) => e instanceof BusinessMapError && /没有在 types/.test((e as Error).message));

  writeBad(dir, {
    version: 1,
    types: [{ id: "project" }],
    objects: [
      { id: "project:x", type: "project", name: "x" },
      { id: "project:x", type: "project", name: "重复" },
    ],
  });
  assert.throws(() => loadBusinessMapFromDir(dir), /id 重复/);

  fs.writeFileSync(path.join(dir, "objects.json"), "{not json", "utf8");
  assert.throws(() => loadBusinessMapFromDir(dir), /不是合法 JSON/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("任务上下文：对象、关系、禁止项都能进文档", () => {
  const x = setup();
  const map = loadBusinessMap(x.store)!;
  const block = renderTaskContext(map, JSON.stringify({
    objects: ["service:rabbit-bot-admin"],
    relations: ["service_deploys_to_env"],
    forbidden: ["env:prod"],
  }));
  assert.match(block, /## 业务上下文/);
  assert.match(block, /service:rabbit-bot-admin/);
  assert.match(block, /deploys_to/);
  assert.match(block, /env:prod/);
  assert.match(block, /禁止/);

  // 任务文档渲染：坏地图/没地图都不能挡住
  const store = new Store(":memory:");
  const task = createTask(store, {
    userId: "u1", poolId: "feishu:oc_x", name: "#发布", goal: "发布 admin",
    work_dir: x.root, context: { objects: ["service:rabbit-bot-admin"], forbidden: ["env:prod"] },
  });
  const doc = renderTaskDoc(task, { businessDir: x.dir });
  assert.match(doc, /## 业务上下文/);
  assert.match(doc, /env:prod/);
  assert.doesNotMatch(renderTaskDoc({ ...task, context: "{}" }, { businessDir: x.dir }), /## 业务上下文/);
  assert.doesNotMatch(renderTaskDoc(task, { businessDir: path.join(x.root, "nope") }), /## 业务上下文/);

  // 正式路径：从 SQLite 读地图
  importBusinessMap(store, x.dir);
  const doc2 = writeTaskDoc(store, task, {});
  assert.match(fs.readFileSync(doc2, "utf8"), /## 业务上下文/);
  store.close();
  cleanup(x);
});

test("map 工具：UFA 有、WA 没有；index/path 可用", async () => {
  const x = setup();
  const store = new Store(":memory:");
  importBusinessMap(store, x.dir);
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_biz", pool_kind: "private", msg_id: "m1",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "看看项目",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0].pool_id;
  const ufa = createTools({ store, hub: {} as any, cfg: x.cfg, now: () => Date.now(), profile: "ufa", primaryPool: () => pool }) as any[];
  assert.ok(ufa.some((t) => t.name === "map"));
  const mapTool = ufa.find((t) => t.name === "map");
  const idx: any = await mapTool.execute("id", { action: "index" });
  assert.equal(idx.details?.ok, true);
  assert.match(textOf(idx), /业务地图/);
  const p: any = await mapTool.execute("id", { action: "path", from: "service:rabbit-bot-admin", to: "env:prod" });
  assert.equal(p.details?.ok, true);
  assert.match(textOf(p), /deploys_to/);

  const wa = createTools({ store, hub: {} as any, cfg: x.cfg, now: () => Date.now(), profile: "wa" }) as any[];
  assert.ok(!wa.some((t) => t.name === "map"));
  store.close();
  cleanup(x);
});

test("task 工具：带 objects 落 context，未知 id 拒绝", async () => {
  const x = setup();
  const store = new Store(":memory:");
  importBusinessMap(store, x.dir);
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_biz2", pool_kind: "private", msg_id: "m2",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "发布一下",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0].pool_id;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-biz-work-"));
  const tools = createTools({ store, hub: {} as any, cfg: x.cfg, now: () => Date.now(), profile: "ufa", primaryPool: () => pool }) as any[];
  const taskTool = tools.find((t) => t.name === "task");

  const ok: any = await taskTool.execute("id", {
    action: "create", name: "#发布", goal: "发布 admin", work_dir: workDir,
    objects: ["service:rabbit-bot-admin"], forbidden: ["env:prod"],
  });
  assert.equal(ok.details?.ok, true, textOf(ok));
  const saved = getTask(store, ok.details.task.id)!;
  assert.deepEqual(JSON.parse(saved.context), {
    objects: ["service:rabbit-bot-admin"], relations: [], forbidden: ["env:prod"],
  });

  const bad: any = await taskTool.execute("id", {
    action: "create", name: "#坏", goal: "坏", work_dir: workDir, objects: ["service:nope"],
  });
  assert.equal(bad.details?.ok, false);
  assert.match(textOf(bad), /没有这些 id/);

  store.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  cleanup(x);
});

test("system prompt：有地图才注入索引", () => {
  const x = setup();
  assert.match(systemPrompt(x.cfg, [], x.store), /业务地图：/);
  assert.match(businessIndexLine(x.store), /map 工具/);
  const empty = new Store(":memory:");
  assert.doesNotMatch(systemPrompt(x.cfg, [], empty), /业务地图：/);
  empty.close();
  cleanup(x);
});

test("ensureBusinessSeeded：空库才导入，已有地图不动", () => {
  const x = setup();
  const store = new Store(":memory:");
  assert.ok(ensureBusinessSeeded(store, x.dir), "空库要导入");
  const version = businessSnapshot(store)!.version;
  assert.equal(ensureBusinessSeeded(store, x.dir), null, "已有地图不再导入");
  assert.equal(businessSnapshot(store)!.version, version);
  store.close();
  cleanup(x);
});

test("replaceBusinessMap：全量替换并校验引用", () => {
  const store = new Store(":memory:");
  const snapshot = {
    version: 2,
    types: [{ id: "service", name: "服务" }, { id: "env", name: "环境" }],
    objects: [
      { id: "service:a", type: "service", name: "a" },
      { id: "env:prod", type: "env", name: "prod" },
    ],
    relations: [{ id: "deploys", name: "deploys_to", fromType: "service", toType: "env", cardinality: "N:N", risk: "high" }],
    edges: [{ relation: "deploys", from: "service:a", to: "env:prod", evidence: "test" }],
    actions: [{ id: "deploy", appliesTo: ["service"], risk: "high", requiresRelations: ["deploys"] }],
    terms: [{ term: "生产", objectId: "env:prod" }],
  };
  const saved = replaceBusinessMap(store, snapshot)!;
  assert.equal(saved.version, 2);
  const map = loadBusinessMap(store)!;
  assert.ok(findPaths(map, "service:a", "env:prod").length);
  assert.deepEqual(impactOf(map, "env:prod").map((h) => h.object.id), ["service:a"]);

  assert.throws(
    () => replaceBusinessMap(store, { ...snapshot, edges: [{ relation: "deploys", from: "service:a", to: "env:nope" }] }),
    /不存在/,
  );
  assert.equal(loadBusinessMap(store)!.version, 2, "失败的替换不该改掉原数据");
  store.close();
});
