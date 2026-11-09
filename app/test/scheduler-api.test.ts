/** 调度设置 API 契约：GET/PUT、持久化、立即生效、非法值 400。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { FakeClock } from "../src/core/clock.ts";
import { Logger } from "../src/core/logger.ts";
import { Scheduler } from "../src/core/scheduler.ts";
import { startApiServer } from "../src/api.ts";
import { loadSchedulerSettings } from "../src/ops/scheduler-settings.ts";
import { createTask } from "../src/core/tasks.ts";
import { listTaskEvents } from "../src/core/task-events.ts";
import type { Wake } from "../src/types.ts";

const dir = path.join(APP_ROOT, ".scratch", "scheduler-api");
const cfg = loadConfig({
  dataDir: dir,
  logDir: path.join(dir, "logs"),
  api: { enabled: true, port: 0, host: "127.0.0.1" },
  exec: { dir: path.join(dir, "sandbox") },
});
const store = new Store(":memory:");
const log = new Logger(null, true);
const token = "s".repeat(32);
const updates: Array<Record<string, number>> = [];
let enqueued = 0;

let server: Awaited<ReturnType<typeof startApiServer>> = null;
let base = "";

test.before(async () => {
  server = await startApiServer({
    cfg, store, log, token,
    scheduler: { updateConfig: (patch) => { updates.push(patch as Record<string, number>); } },
    enqueue: () => { enqueued++; },
  });
  const addr = server!.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

test.after(() => {
  server?.close();
  store.close();
});

const call = async (p: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${p}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers as any) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
};

test("GET /v1/scheduler 返回三个值", async () => {
  const r = await call("/v1/scheduler");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, {
    privateWakeMs: 5000,
    groupWakeMs: 180000,
    taskWakeMs: 180000,
  });
});

test("PUT /v1/scheduler：合法值 200、写文件、改 cfg、调用 updateConfig", async () => {
  const r = await call("/v1/scheduler", {
    method: "PUT",
    body: JSON.stringify({ privateWakeMs: 12000, groupWakeMs: 60000, taskWakeMs: 30000 }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { privateWakeMs: 12000, groupWakeMs: 60000, taskWakeMs: 30000 });

  assert.equal(cfg.scheduler.privateWakeMs, 12000);
  assert.equal(cfg.scheduler.tickMs, 60000);
  assert.equal(cfg.scheduler.taskTickMs, 30000);

  const file = path.join(dir, "run", "scheduler.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.privateWakeMs, 12000);
  assert.equal(saved.groupWakeMs, 60000);
  assert.equal(saved.taskWakeMs, 30000);
  assert.equal(typeof saved.updated_at, "string");

  assert.deepEqual(updates.at(-1), { privateWakeMs: 12000, tickMs: 60000, taskTickMs: 30000 });

  const got = await call("/v1/scheduler");
  assert.deepEqual(got.body.data, { privateWakeMs: 12000, groupWakeMs: 60000, taskWakeMs: 30000 });
});

test("PUT /v1/scheduler：非法值 400，且不应用", async () => {
  const before = updates.length;
  const bad = [
    { privateWakeMs: 0, groupWakeMs: 60000, taskWakeMs: 30000 },
    { privateWakeMs: 5000, groupWakeMs: -1, taskWakeMs: 30000 },
    { privateWakeMs: 5000, groupWakeMs: 60000, taskWakeMs: 86400001 },
    { privateWakeMs: "5000", groupWakeMs: 60000, taskWakeMs: 30000 },
    { privateWakeMs: 5000, groupWakeMs: 60000 },
  ];
  for (const body of bad) {
    const r = await call("/v1/scheduler", { method: "PUT", body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(updates.length, before, "非法值不该调用 updateConfig");
  assert.equal(cfg.scheduler.privateWakeMs, 12000);
});

test("旧 scheduler.json 缺 taskWakeMs 时用默认值加载", () => {
  const oldDir = path.join(APP_ROOT, ".scratch", "scheduler-api-old");
  const file = path.join(oldDir, "run", "scheduler.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    privateWakeMs: 9000,
    groupWakeMs: 120000,
    updated_at: "2020-01-01T00:00:00.000Z",
  }), "utf8");

  const freshCfg = loadConfig({
    dataDir: oldDir,
    logDir: path.join(oldDir, "logs"),
    api: { enabled: true, port: 0, host: "127.0.0.1" },
    exec: { dir: path.join(oldDir, "sandbox") },
  });
  const loaded = loadSchedulerSettings(freshCfg);
  assert.deepEqual(loaded, { privateWakeMs: 9000, groupWakeMs: 120000, taskWakeMs: 180000 });
  assert.equal(freshCfg.scheduler.privateWakeMs, 9000);
  assert.equal(freshCfg.scheduler.tickMs, 120000);
  assert.equal(freshCfg.scheduler.taskTickMs, 180000);
});

test("未传 scheduler 时 PUT 仍能持久化", async () => {
  const second = await startApiServer({ cfg, store, log, token });
  assert.ok(second);
  const addr = second!.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/scheduler`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ privateWakeMs: 7000, groupWakeMs: 90000, taskWakeMs: 45000 }),
    });
    assert.equal(res.status, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "run", "scheduler.json"), "utf8"));
    assert.equal(saved.privateWakeMs, 7000);
    assert.equal(saved.groupWakeMs, 90000);
    assert.equal(saved.taskWakeMs, 45000);
  } finally {
    await new Promise<void>((r) => second!.close(() => r()));
  }
});

test("POST /v1/tasks/:id/status：blocked 写任务事件但不立即 enqueue，下一次任务 tick 才 batch", async () => {
  const task = createTask(store, { userId: "u1", poolId: "p1", name: "#阻塞", goal: "等外部接口" });
  const before = enqueued;

  const first = await call(`/v1/tasks/${task.id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "blocked" }),
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.status, "blocked");
  assert.equal(enqueued, before, "状态事件不该立即 enqueue");

  const events = listTaskEvents(store, task.id, { limit: 5 });
  assert.ok(events.some((e) => e.text.includes("任务状态：blocked")), "blocked 应写任务事件");
  assert.ok(store.poolsWithUnread().includes(task.task_pool_id), "任务池应有未读");

  const clock = new FakeClock();
  const wakes: Wake[] = [];
  const scheduler = new Scheduler({
    tickMs: 180_000, activeTickMs: 180_000, activeWindowMs: 600_000,
    debounceMs: 30_000, debounceMaxWaitMs: 120_000, taskTickMs: 45_000,
  }, {
    clock,
    queue: { enqueue: (w) => { wakes.push(w); return "queued" as const; } },
    isPaused: () => false,
    poolsWithUnread: () => store.poolsWithUnread(),
    duePlans: () => [],
    poolKind: (id) => store.getPool(id)?.kind,
  });
  scheduler.start();
  clock.advance(44_999);
  assert.equal(wakes.length, 0, "未到任务 tick 不唤醒");
  clock.advance(1);
  assert.equal(wakes.length, 1, "任务 tick 一次 batch");
  assert.equal(wakes[0].type, "tick");
  assert.deepEqual([...wakes[0].pools], [task.task_pool_id]);
  assert.match(wakes[0].reasons[0], /任务事件 batch/);
  scheduler.stop();
});
