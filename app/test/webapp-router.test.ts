import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGE_VIEWS,
  formatRoute,
  parseRoute,
  sameRoute,
  type Route,
} from "../webapp/src/lib/router.ts";

test("默认视图与非法降级", () => {
  assert.deepEqual(parseRoute(""), { tab: "overview" });
  assert.deepEqual(parseRoute("?tab=nope"), { tab: "overview" });
  assert.deepEqual(parseRoute("?tab=chat"), { tab: "chat" });

  assert.deepEqual(parseRoute("?tab=work"), { tab: "work", view: "tasks" });
  assert.deepEqual(parseRoute("?tab=work&view=nope"), { tab: "work", view: "tasks" });

  assert.deepEqual(parseRoute("?tab=approvals"), { tab: "approvals", view: "pending" });
  assert.deepEqual(parseRoute("?tab=approvals&view=nope"), {
    tab: "approvals",
    view: "pending",
  });
  assert.deepEqual(parseRoute("?tab=approvals&view=reads"), {
    tab: "approvals",
    view: "reads",
  });

  assert.deepEqual(parseRoute("?tab=memories"), { tab: "memories", view: "entries" });
  assert.deepEqual(parseRoute("?tab=memories&view=graph"), {
    tab: "memories",
    view: "graph",
  });
  assert.deepEqual(parseRoute("?tab=memories&view=nope"), {
    tab: "memories",
    view: "entries",
  });

  assert.deepEqual(parseRoute("?tab=manage"), { tab: "manage", view: "usage" });
  assert.deepEqual(parseRoute("?tab=manage&view=llm-logs"), {
    tab: "manage",
    view: "llm-logs",
  });
  assert.deepEqual(parseRoute("?tab=manage&view=nope"), {
    tab: "manage",
    view: "usage",
  });
});

test("task / id 非法值降级", () => {
  assert.deepEqual(parseRoute("?tab=work&view=tasks&task=0"), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=work&view=tasks&task=-1"), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=work&view=tasks&task=abc"), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=work&view=tasks&task=1.5"), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=approvals&id=0"), {
    tab: "approvals",
    view: "pending",
  });
  assert.deepEqual(parseRoute("?tab=approvals&id=-3"), {
    tab: "approvals",
    view: "pending",
  });
  assert.deepEqual(parseRoute("?tab=approvals&view=reads&id=5"), {
    tab: "approvals",
    view: "reads",
  });
});

test("work 的 outputs / project 约束", () => {
  assert.deepEqual(parseRoute("?tab=work&view=outputs&task=5"), {
    tab: "work",
    view: "outputs",
  });
  assert.deepEqual(parseRoute("?tab=work&view=outputs&path=tasks/12/report.md"), {
    tab: "work",
    view: "outputs",
    path: "tasks/12/report.md",
  });
  assert.deepEqual(parseRoute("?tab=work&view=project"), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=work&view=project&slug="), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=work&view=project&slug=foo&task=3"), {
    tab: "work",
    view: "project",
    slug: "foo",
    task: 3,
  });
});

test("旧管理 tab 映射到 manage", () => {
  const legacy = [
    "users",
    "persona",
    "schedules",
    "settings",
    "usage",
    "task-stats",
    "skills",
  ] as const;
  for (const tab of legacy) {
    assert.deepEqual(parseRoute(`?tab=${tab}`), { tab: "manage", view: tab });
  }
});

test("旧 business 链接映射到 memories/graph", () => {
  assert.deepEqual(parseRoute("?tab=business"), { tab: "memories", view: "graph" });
  assert.deepEqual(parseRoute("?tab=manage&view=business"), {
    tab: "memories",
    view: "graph",
  });
});

test("旧任务类 tab 映射到 work", () => {
  for (const tab of ["tasks", "plans", "projects"]) {
    assert.deepEqual(parseRoute(`?tab=${tab}`), { tab: "work", view: "tasks" });
  }
  assert.deepEqual(parseRoute("?tab=outputs"), { tab: "work", view: "outputs" });
  assert.deepEqual(parseRoute("?tab=outputs&path=tasks/1/a.md"), {
    tab: "work",
    view: "outputs",
    path: "tasks/1/a.md",
  });
});

test("旧 work scope 映射", () => {
  assert.deepEqual(parseRoute("?tab=work&scope=tasks"), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=work&scope=projects"), {
    tab: "work",
    view: "tasks",
  });
  assert.deepEqual(parseRoute("?tab=work&scope=outputs"), {
    tab: "work",
    view: "outputs",
  });
  assert.deepEqual(parseRoute("?tab=work&scope=outputs&path=tasks/9/a.md"), {
    tab: "work",
    view: "outputs",
    path: "tasks/9/a.md",
  });
  assert.deepEqual(parseRoute("?tab=work&scope=project:foo"), {
    tab: "work",
    view: "project",
    slug: "foo",
  });
  assert.deepEqual(parseRoute("?tab=work&scope=task:12"), {
    tab: "work",
    view: "tasks",
    task: 12,
  });
  assert.deepEqual(parseRoute("?tab=work&scope=task:12&from=project:foo"), {
    tab: "work",
    view: "project",
    slug: "foo",
    task: 12,
  });
  assert.deepEqual(parseRoute("?tab=work&scope=task:12&from=tasks"), {
    tab: "work",
    view: "tasks",
    task: 12,
  });
  assert.deepEqual(parseRoute("?tab=work&scope=task:abc"), {
    tab: "work",
    view: "tasks",
  });
});

test("旧审批 scope 映射", () => {
  assert.deepEqual(parseRoute("?tab=approvals&scope=approvals"), {
    tab: "approvals",
    view: "pending",
  });
  assert.deepEqual(parseRoute("?tab=approvals&scope=log"), {
    tab: "approvals",
    view: "reads",
  });
  assert.deepEqual(parseRoute("?tab=approvals&scope=rules"), {
    tab: "approvals",
    view: "reads",
  });
});

test("formatRoute 往返稳定", () => {
  const samples: Route[] = [
    { tab: "overview" },
    { tab: "chat" },
    { tab: "work", view: "tasks" },
    { tab: "work", view: "tasks", task: 12 },
    { tab: "work", view: "outputs" },
    { tab: "work", view: "outputs", path: "tasks/12/report.md" },
    { tab: "work", view: "project", slug: "foo" },
    { tab: "work", view: "project", slug: "foo", task: 12 },
    { tab: "approvals", view: "pending" },
    { tab: "approvals", view: "pending", id: 7 },
    { tab: "approvals", view: "reads" },
    { tab: "memories", view: "entries" },
    { tab: "memories", view: "graph" },
    ...MANAGE_VIEWS.map((view): Route => ({ tab: "manage", view })),
  ];

  for (const route of samples) {
    const formatted = formatRoute(route);
    assert.deepEqual(parseRoute(formatted), route, formatted);
    assert.equal(formatRoute(parseRoute(formatted)), formatted, formatted);
  }
});

test("参数顺序固定", () => {
  assert.equal(
    formatRoute({ tab: "work", view: "project", slug: "foo", task: 12 }),
    "?tab=work&view=project&slug=foo&task=12",
  );
  assert.equal(
    formatRoute({ tab: "work", view: "outputs", path: "tasks/1/a.md" }),
    "?tab=work&view=outputs&path=tasks%2F1%2Fa.md",
  );
  assert.equal(
    formatRoute({ tab: "approvals", view: "pending", id: 7 }),
    "?tab=approvals&view=pending&id=7",
  );
  assert.equal(formatRoute({ tab: "memories", view: "graph" }), "?tab=memories&view=graph");
  assert.equal(formatRoute({ tab: "manage", view: "llm-logs" }), "?tab=manage&view=llm-logs");
});

test("sameRoute 比较语义值", () => {
  assert.equal(
    sameRoute(
      { tab: "work", view: "tasks", task: 1 },
      { tab: "work", view: "tasks", task: 1 },
    ),
    true,
  );
  assert.equal(
    sameRoute(
      { tab: "work", view: "tasks" },
      { tab: "work", view: "outputs" },
    ),
    false,
  );
  assert.equal(
    sameRoute(
      { tab: "approvals", view: "pending", id: 2 },
      { tab: "approvals", view: "pending" },
    ),
    false,
  );
  assert.equal(sameRoute({ tab: "overview" }, { tab: "overview" }), true);
});