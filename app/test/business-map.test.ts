/** 业务地图：加载、校验、解析、路径、影响面、任务上下文。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { createTask, getTask } from "../src/core/tasks.ts";
import { renderTaskDoc } from "../src/core/dispatch.ts";
import { createTools } from "../src/agent/tools.ts";
import { systemPrompt } from "../src/agent/prompt.ts";
import {
  BusinessMapError, businessIndexLine, findPaths, impactOf, loadBusinessMap, loadBusinessMapFromDir,
  renderIndex, renderTaskContext, resolveObjects, showObject,
} from "../src/ops/business-map.ts";

const EXAMPLES = path.resolve(import.meta.dirname, "../../docs/examples/business");

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-biz-"));
  const dir = path.join(root, "business");
  fs.cpSync(EXAMPLES, dir, { recursive: true });
  const cfg = loadConfig({ runtimeDir: root, exec: { dir: path.join(root, "sandbox") } });
  return { root, dir, cfg };
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
  fs.rmSync(root, { recursive: true, force: true });
});

test("加载示例地图：类型/关系/对象数量正确", () => {
  const { root, dir, cfg } = setup();
  const map = loadBusinessMap(cfg)!;
  assert.ok(map);
  assert.equal(map.types.length, 5);
  assert.equal(map.relations.length, 4);
  assert.equal(map.objects.length, 7);
  assert.match(renderIndex(map), /business|project/);
  assert.match(renderIndex(map), /service_deploys_to_env/);
  assert.equal(loadBusinessMapFromDir(dir)!.objects.length, 7);
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolve：精确、别名、术语、词法", () => {
  const { root, cfg } = setup();
  const map = loadBusinessMap(cfg)!;
  assert.equal(resolveObjects(map, "service:rabbit-bot-admin")[0].object.id, "service:rabbit-bot-admin");
  assert.equal(resolveObjects(map, "管理后台")[0].object.id, "service:rabbit-bot-admin");
  assert.equal(resolveObjects(map, "老地方")[0].object.id, "env:prod");
  assert.ok(resolveObjects(map, "个人 IM").some((h) => h.object.id === "project:rabbit-bot"));
  assert.equal(resolveObjects(map, "完全不存在").length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("show：对象卡片带出直接关系", () => {
  const { root, cfg } = setup();
  const map = loadBusinessMap(cfg)!;
  const view = showObject(map, "service:rabbit-bot-api")!;
  assert.ok(view);
  assert.equal(view.object.name, "api");
  assert.ok(view.outgoing.some((n) => n.relation === "service_deploys_to_env" && n.other.id === "env:prod"));
  assert.ok(view.outgoing.some((n) => n.relation === "service_deploys_to_env" && n.other.id === "env:staging"));
  assert.ok(view.outgoing.some((n) => n.relation === "service_belongs_to_project" && n.other.id === "project:rabbit-bot"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("path / impact：file mapping 在查询时算边", () => {
  const { root, cfg } = setup();
  const map = loadBusinessMap(cfg)!;
  const paths = findPaths(map, "service:rabbit-bot-admin", "env:prod");
  assert.equal(paths.length, 1);
  assert.equal(paths[0][0].relation, "service_deploys_to_env");

  const prod = impactOf(map, "env:prod").map((h) => h.object.id).sort();
  assert.deepEqual(prod, ["service:rabbit-bot-admin", "service:rabbit-bot-api"]);

  const project = impactOf(map, "project:rabbit-bot").map((h) => h.object.id).sort();
  assert.deepEqual(project, ["person:viking", "repo:rabbit-bot", "service:rabbit-bot-admin", "service:rabbit-bot-api"]);

  assert.deepEqual(findPaths(map, "service:rabbit-bot-admin", "person:viking"), [], "不做传递闭包");
  fs.rmSync(root, { recursive: true, force: true });
});

test("改 deploy 文件后重新加载能看到新边", () => {
  const { root, dir, cfg } = setup();
  const before = loadBusinessMap(cfg)!;
  assert.ok(findPaths(before, "service:rabbit-bot-admin", "env:prod").length);
  // 写短一点，确保 size 变化能让 mtime 缓存失效
  fs.writeFileSync(path.join(dir, "deploy/prod.json"), '{"services":["rabbit-bot-api"]}', "utf8");
  const after = loadBusinessMap(cfg)!;
  assert.equal(findPaths(after, "service:rabbit-bot-admin", "env:prod").length, 0);
  assert.ok(findPaths(after, "service:rabbit-bot-api", "env:prod").length);
  fs.rmSync(root, { recursive: true, force: true });
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
  const { root, dir, cfg } = setup();
  const map = loadBusinessMap(cfg)!;
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
    work_dir: root, context: { objects: ["service:rabbit-bot-admin"], forbidden: ["env:prod"] },
  });
  const doc = renderTaskDoc(task, { businessDir: dir });
  assert.match(doc, /## 业务上下文/);
  assert.match(doc, /env:prod/);
  assert.doesNotMatch(renderTaskDoc({ ...task, context: "{}" }, { businessDir: dir }), /## 业务上下文/);
  assert.doesNotMatch(renderTaskDoc(task, { businessDir: path.join(root, "nope") }), /## 业务上下文/);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("map 工具：UFA 有、WA 没有；index/path 可用", async () => {
  const { root, cfg } = setup();
  const store = new Store(":memory:");
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_biz", pool_kind: "private", msg_id: "m1",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "看看项目",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0].pool_id;
  const ufa = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa", primaryPool: () => pool }) as any[];
  assert.ok(ufa.some((t) => t.name === "map"));
  const mapTool = ufa.find((t) => t.name === "map");
  const idx: any = await mapTool.execute("id", { action: "index" });
  assert.equal(idx.details?.ok, true);
  assert.match(textOf(idx), /业务地图/);
  const p: any = await mapTool.execute("id", { action: "path", from: "service:rabbit-bot-admin", to: "env:prod" });
  assert.equal(p.details?.ok, true);
  assert.match(textOf(p), /deploys_to/);

  const wa = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "wa" }) as any[];
  assert.ok(!wa.some((t) => t.name === "map"));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("task 工具：带 objects 落 context，未知 id 拒绝", async () => {
  const { root, cfg } = setup();
  const store = new Store(":memory:");
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_biz2", pool_kind: "private", msg_id: "m2",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "发布一下",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0].pool_id;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-biz-work-"));
  const tools = createTools({ store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa", primaryPool: () => pool }) as any[];
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
  fs.rmSync(root, { recursive: true, force: true });
});

test("system prompt：有地图才注入索引", () => {
  const { root, cfg } = setup();
  assert.match(systemPrompt(cfg, []), /业务地图：/);
  assert.match(businessIndexLine(cfg), /map 工具/);

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-biz-nomap-"));
  const cfg2 = loadConfig({ runtimeDir: emptyRoot });
  assert.doesNotMatch(systemPrompt(cfg2, []), /业务地图：/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(emptyRoot, { recursive: true, force: true });
});
