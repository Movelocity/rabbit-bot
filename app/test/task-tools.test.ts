import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { registerWorker } from "../src/core/workers.ts";
import { getTask } from "../src/core/tasks.ts";
import { appendTaskEvent } from "../src/core/task-events.ts";

function setup(profile: "ufa" | "wa" = "ufa", opts: { shellMode?: "host" | "docker"; approval?: boolean } = {}) {
  // 工具集要按模式/审批分岔，测试里显式给定，别依赖本机 config/local.json。
  const cfg = loadConfig({
    exec: { shell: { mode: opts.shellMode ?? "docker" } },
    approval: { enabled: opts.approval ?? false },
  });
  const store = new Store(":memory:");
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_task", pool_kind: "private", msg_id: "m1",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "帮我弄一下",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0]?.pool_id ?? null;
  const calls: string[][] = [];
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(),
    primaryPool: () => pool,
    profile,
    rbExec: async (argv: string[]) => { calls.push(argv); return { ok: true, code: 0, output: "{}" }; },
  }) as any[];
  const get = (n: string) => tools.find((t) => t.name === n);
  const run = async (name: string, params: any) => {
    const r = await get(name).execute("id", params);
    const raw = (r as any).content;
    const text = Array.isArray(raw)
      ? raw.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("")
      : String(raw ?? "");
    return { ...r, text };
  };
  return { cfg, store, pool, calls, tools, get, run };
}

test("task：create → list → get → note → status → cancel", async () => {
  const { run, store, pool } = setup();
  const created = await run("task", {
    action: "create",
    name: "纪要",
    goal: "整理会议纪要",
    work_dir: process.cwd(),
    deliverable: "notes.md",
    constraints: "只读不写",
    acceptance: "有结论和待办",
    files: ["a.txt", "b.txt"],
    start_at: new Date(0).toISOString(),
  });
  assert.equal(created.details?.ok, true, created.text);
  const id = created.details.task.id;
  assert.equal(created.details.task.name, "#纪要", "工具会把缺的 # 补上");
  assert.equal(created.details.task.status, "pending_approval");
  assert.match(created.text, /等待 Web 审批/);
  assert.equal(getTask(store, id)?.user_id, store.lastUserId(pool!));
  assert.equal(getTask(store, id)?.start_at, 0);

  const listed = await run("task", { action: "list", status: "pending_approval" });
  assert.equal(listed.details?.ok, true, listed.text);
  assert.equal(listed.details.count, 1);
  assert.match(listed.text, /整理会议纪要/);

  const got = await run("task", { action: "get", id });
  assert.equal(got.details?.ok, true, got.text);
  assert.equal(got.details.task.id, id);

  const noted = await run("task", { action: "note", id, line: "先看附件" });
  assert.equal(noted.details?.ok, true, noted.text);
  assert.equal(getTask(store, id)?.note, "先看附件");

  const done = await run("task", { action: "status", id, status: "done", result: "写好了", artifact: "notes.md" });
  assert.equal(done.details?.ok, true, done.text);
  assert.equal(getTask(store, id)?.status, "done");
  assert.equal(getTask(store, id)?.result, "写好了");
  assert.equal(getTask(store, id)?.artifact, "notes.md");

  const cancelled = await run("task", { action: "cancel", id });
  assert.equal(cancelled.details?.ok, true, cancelled.text);
  assert.equal(getTask(store, id)?.status, "cancelled");
});

test("task：缺参、非法 status、不存在 id 都明确报错，不抛崩", async () => {
  const { run } = setup();

  const noName = await run("task", { action: "create" });
  assert.equal(noName.details?.ok, false);
  assert.match(noName.text, /短任务名/);
  assert.match(noName.text, /#xxx/);

  const blankName = await run("task", { action: "create", name: "  ", goal: "干活", work_dir: process.cwd() });
  assert.equal(blankName.details?.ok, false);
  assert.match(blankName.text, /短任务名/);

  const noGoal = await run("task", { action: "create", name: "#干活" });
  assert.equal(noGoal.details?.ok, false);
  assert.match(noGoal.text, /goal/);

  const noWorkDir = await run("task", { action: "create", name: "#干活", goal: "干活" });
  assert.equal(noWorkDir.details?.ok, false);
  assert.match(noWorkDir.text, /work_dir/);

  const relative = await run("task", { action: "create", name: "#干活", goal: "干活", work_dir: "relative/dir" });
  assert.equal(relative.details?.ok, false);
  assert.match(relative.text, /绝对路径/);

  const badList = await run("task", { action: "list", status: "wat" });
  assert.equal(badList.details?.ok, false);
  assert.match(badList.text, /status/);

  const badGet = await run("task", { action: "get" });
  assert.equal(badGet.details?.ok, false);
  assert.match(badGet.text, /id/);

  const missing = await run("task", { action: "get", id: 999999 });
  assert.equal(missing.details?.ok, false);
  assert.match(missing.text, /没有任务/);

  const noLine = await run("task", { action: "note", id: 1 });
  assert.equal(noLine.details?.ok, false);
  assert.match(noLine.text, /line/);

  const badStatus = await run("task", { action: "status", id: 1, status: "wat" });
  assert.equal(badStatus.details?.ok, false);
  assert.match(badStatus.text, /status/);

  const noId = await run("task", { action: "cancel" });
  assert.equal(noId.details?.ok, false);
  assert.match(noId.text, /id/);

  const gone = await run("task", { action: "cancel", id: 999999 });
  assert.equal(gone.details?.ok, false);
  assert.match(gone.text, /没有任务/);
});

test("worker：list 返回 worker_id / name / kind / status / last_seen_at", async () => {
  const { run, store } = setup();
  registerWorker(store, { workerId: "wa-1", name: "本地", kind: "wa" });

  const r = await run("worker", { action: "list" });
  assert.equal(r.details?.ok, true, r.text);
  assert.equal(r.details.count, 1);
  assert.deepEqual(r.details.workers[0], {
    worker_id: "wa-1",
    name: "本地",
    kind: "wa",
    status: "online",
    last_seen_at: r.details.workers[0].last_seen_at,
  });
});

test("工具集按 profile 分：UFA 沙盒始终有 terminal，host 需审批；WA 始终有", () => {
  const ufa = setup().tools.map((t: any) => t.name);
  for (const name of ["chat", "memory", "plan", "approval", "task", "worker", "read_file", "rb"]) {
    assert.ok(ufa.includes(name), `UFA 少了 ${name}：${ufa.join(",")}`);
  }
  assert.ok(!ufa.includes("write_file"), `UFA 不该有 write_file：${ufa.join(",")}`);
  assert.ok(ufa.includes("terminal"), `docker 沙盒里 UFA 该有 terminal：${ufa.join(",")}`);

  const ufaHost = setup(undefined, { shellMode: "host", approval: true }).tools.map((t: any) => t.name);
  assert.ok(ufaHost.includes("terminal"), `host+审批开时 UFA 该有 terminal：${ufaHost.join(",")}`);

  const wa = setup("wa").tools.map((t: any) => t.name);
  assert.deepEqual([...wa].sort(), ["rb", "read_file", "terminal", "write_file"]);
  for (const name of ["chat", "memory", "plan", "approval", "task", "worker"]) {
    assert.ok(!wa.includes(name), `WA 不该有 ${name}`);
  }
});

test("task updates / get：返回任务池里的带时间戳事件", async () => {
  const { run, store } = setup();
  const created = await run("task", { action: "create", name: "#看进度", goal: "看进度", work_dir: process.cwd() });
  const id = created.details.task.id;

  appendTaskEvent(store, id, { text: "worker wa-1 领取任务，开始执行", sender: "wa-1", ts: 1000 });
  appendTaskEvent(store, id, { text: "阶段 working\n正在跑", sender: "wa-1", ts: 2000 });

  const updates = await run("task", { action: "updates", id });
  assert.equal(updates.details?.ok, true, updates.text);
  assert.equal(updates.details.name, "#看进度");
  assert.equal(updates.details.count, 2);
  assert.match(updates.text, /领取任务/);
  assert.match(updates.text, /阶段 working/);
  assert.match(updates.text, /wa-1/);

  const got = await run("task", { action: "get", id });
  assert.equal(got.details?.ok, true, got.text);
  assert.equal(got.details.task.name, "#看进度");
  assert.ok(got.details.task.task_pool_id);
  assert.equal(got.details.task.recent_events.length, 2);

  const missing = await run("task", { action: "updates", id: 999999 });
  assert.equal(missing.details?.ok, false);
  assert.match(missing.text, /没有任务/);
});

test("rb task-list / worker-list：只读，直接查库，不进沙盒", async () => {
  const { run, calls, store } = setup();
  await run("task", { action: "create", name: "#查一下", goal: "查一下这个", work_dir: process.cwd() });
  registerWorker(store, { workerId: "wa-1", name: "本地" });

  const tasks = await run("rb", { args: "task-list --status pending_approval" });
  assert.equal(tasks.details?.ok, true, tasks.text);
  assert.equal(tasks.details.count, 1);
  assert.match(tasks.text, /查一下这个/);

  const workers = await run("rb", { args: "worker-list" });
  assert.equal(workers.details?.ok, true, workers.text);
  assert.match(workers.text, /wa-1/);

  const bad = await run("rb", { args: "task-list --status wat" });
  assert.equal(bad.details?.ok, false);
  assert.match(bad.text, /status/);

  assert.deepEqual(calls, []);
});
