import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import {
  createTask, parseTaskContext, PROJECT_OBJECT_PREFIX,
} from "../src/core/tasks.ts";
import {
  matchProjectSlugByWorkDir, projectPathEntries, type ProjectPathEntry,
} from "../src/core/project-match.ts";

function addProject(s: Store, id: string, sourcePath: string) {
  s.db.prepare(
    "INSERT INTO business_objects(id,type,name,source_kind,source_value) VALUES(?,?,?,?,?)",
  ).run(id, "project", id, "path", sourcePath);
}

const mk = (s: Store, workDir: string, extra: Record<string, unknown> = {}) =>
  createTask(s, { userId: "u1", poolId: "p1", name: "#测试", goal: "干点活", work_dir: workDir, ...extra });

test("project-match：绝对路径前缀、相对路径尾段、最长匹配优先", () => {
  const entries: ProjectPathEntry[] = [
    { slug: "growthos", paths: ["GrowthOS"] },
    { slug: "erp-gva", paths: ["GrowthOS/products/erp-gva"] },
    { slug: "rabbit-bot", paths: ["/Users/dev/projects/rabbit-bot"] },
  ];
  assert.equal(
    matchProjectSlugByWorkDir("/Users/dev/projects/sw-proj/GrowthOS/products/erp-gva/sub", entries),
    "erp-gva",
    "相对路径要按尾段命中，且取更具体的长路径",
  );
  assert.equal(matchProjectSlugByWorkDir("/Users/dev/projects/rabbit-bot/app", entries), "rabbit-bot");
  assert.equal(matchProjectSlugByWorkDir("/Users/dev/projects/sw-proj/GrowthOS", entries), "growthos");
});

test("project-match：路径段边界不被部分词误命中", () => {
  const entries: ProjectPathEntry[] = [{ slug: "erp-gva", paths: ["erp-gva"] }];
  assert.equal(matchProjectSlugByWorkDir("/x/foo-erp-gva", entries), null);
  assert.equal(matchProjectSlugByWorkDir("/x/erp-gvax", entries), null);
  assert.equal(matchProjectSlugByWorkDir("/x/erp-gva", entries), "erp-gva");
});

test("project-match：同长度歧义、空目录、无命中都返回 null", () => {
  const entries: ProjectPathEntry[] = [
    { slug: "a", paths: ["shared/thing"] },
    { slug: "b", paths: ["shared/thing"] },
  ];
  assert.equal(matchProjectSlugByWorkDir("/root/shared/thing", entries), null, "歧义不猜");
  assert.equal(matchProjectSlugByWorkDir("", entries), null);
  assert.equal(matchProjectSlugByWorkDir("/root/other", entries), null);
});

test("projectPathEntries：兼容 DB snake_case 行与业务地图 camelCase 对象", () => {
  const fromDb = projectPathEntries([
    { id: "project:erp-gva", type: "project", source_kind: "path", source_value: "GrowthOS/products/erp-gva" },
    { id: "service:x", type: "service", source_kind: "path", source_value: "x" },
    { id: "project:no-src", type: "project" },
  ]);
  assert.deepEqual(fromDb, [{ slug: "erp-gva", paths: ["GrowthOS/products/erp-gva"] }]);

  const fromMap = projectPathEntries([
    { id: "project:rabbit-bot", type: "project", source: { kind: "path", value: "/Users/dev/projects/rabbit-bot" } },
  ]);
  assert.deepEqual(fromMap, [{ slug: "rabbit-bot", paths: ["/Users/dev/projects/rabbit-bot"] }]);
});

test("createTask：work_dir 命中项目时自动补 project:<slug>", () => {
  const s = new Store(":memory:");
  addProject(s, "project:erp-gva", "GrowthOS/products/erp-gva");

  const t = mk(s, "/Users/dev/projects/sw-proj/GrowthOS/products/erp-gva");
  const ctx = parseTaskContext(t.context);
  assert.deepEqual(ctx.objects, [`${PROJECT_OBJECT_PREFIX}erp-gva`]);

  s.close();
});

test("createTask：已显式带项目就不覆盖", () => {
  const s = new Store(":memory:");
  addProject(s, "project:growthos", "GrowthOS");
  addProject(s, "project:erp-gva", "GrowthOS/products/erp-gva");

  const t = mk(s, "/Users/dev/projects/sw-proj/GrowthOS/products/erp-gva", {
    context: { objects: ["project:growthos"] },
  });
  assert.deepEqual(parseTaskContext(t.context).objects, ["project:growthos"]);

  s.close();
});

test("createTask：无命中或没有业务地图时正常建任务、context 不变", () => {
  const s = new Store(":memory:");
  const noMap = mk(s, "/Users/dev/projects/sw-proj/GrowthOS/products/erp-gva");
  assert.deepEqual(parseTaskContext(noMap.context).objects, []);

  addProject(s, "project:erp-gva", "GrowthOS/products/erp-gva");
  const miss = mk(s, "/tmp/not-a-project");
  assert.deepEqual(parseTaskContext(miss.context).objects, []);

  s.close();
});
