/**
 * 执行器进程脱离主进程树 + 服务重启后 re-attach：
 *   1. startTask 拉起的执行器不能是 rabbit-bot 的子孙（pm2 restart 的 treekill 会按 ppid 杀整棵树）；
 *   2. 主服务被 SIGKILL 后执行器仍然活着，pid 与状态落在 runner.state.json；
 *   3. 新进程启动后 sweepDeadRunners 能接回还活着的执行器；
 *   4. 执行器退出后，接管方能从状态文件拿到退出码并补任务事件与用量。
 *
 * 用独立子进程当「主服务」，因为要真的杀掉它；测试进程本身不能死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { APP_ROOT } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { getTask } from "../src/core/tasks.ts";
import { listTaskEvents } from "../src/core/task-events.ts";
import { sweepDeadRunners } from "../src/core/dispatch.ts";
import { readRunnerState } from "../src/core/runner-state.ts";

const root = path.join(APP_ROOT, ".scratch", "runner-reattach");
const workDir = path.join(root, "work");
const dataDir = path.join(root, "data");
const dbFile = path.join(root, "test.db");
const fakeBin = path.join(root, "fake-exec.mjs");
const server = path.join(root, "server.ts");

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

fs.writeFileSync(fakeBin, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "step_start", sessionID: "ses_reattach" }));
if (process.env.FAKE_TOKENS) {
  console.log(JSON.stringify({ type: "step_finish", timestamp: Date.now(), part: {
    tokens: { input: 10, output: 5, reasoning: 0, total: 15, cache: { read: 2, write: 1 } },
    cost: 0.001,
  } }));
}
setTimeout(() => process.exit(0), Number(process.env.FAKE_SLEEP || 2000));
`, "utf8");
fs.chmodSync(fakeBin, 0o755);

fs.writeFileSync(server, `import fs from "node:fs";
import { Store } from "../../src/core/db.ts";
import { createTask } from "../../src/core/tasks.ts";
import { sweepDeadRunners, startTask } from "../../src/core/dispatch.ts";

const [dbFile, dataDir, workDir, fakeBin, outFile, mode] = process.argv.slice(2);
const store = new Store(dbFile);
const task = store.db.prepare("SELECT * FROM tasks WHERE id=1").get()
  ?? createTask(store, { userId: "u1", poolId: "p1", name: "#接管", goal: "跑久一点", work_dir: workDir });

if (mode === "start") {
  const r = await startTask(store, task, {
    apiBase: "http://127.0.0.1:1", token: "t", dataDir, executorBin: fakeBin,
  });
  fs.writeFileSync(outFile, JSON.stringify({ pid: r.pid, session: r.session_id, task_id: task.id }));
} else {
  const sweep = sweepDeadRunners(store, { dataDir });
  fs.writeFileSync(outFile, JSON.stringify({ sweep, task: store.db.prepare("SELECT id,status,runner_pid FROM tasks WHERE id=1").get() }));
}
// 保持「主服务」活着，等测试来杀
setInterval(() => {}, 1000);
`, "utf8");

interface ServerHandle {
  child: ReturnType<typeof spawn>;
  out: string;
}

async function waitFile(file: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.trim()) return JSON.parse(raw);
    } catch { /* 还没写 */ }
    if (Date.now() >= deadline) throw new Error(`等 ${path.basename(file)} 超时`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function spawnServer(tag: string, mode: string): ServerHandle {
  const out = path.join(root, `${tag}.json`);
  fs.rmSync(out, { force: true });
  const child = spawn(process.execPath, ["--import", "tsx", server, dbFile, dataDir, workDir, fakeBin, out, mode], {
    cwd: APP_ROOT,
    stdio: "ignore",
    env: { ...process.env, FAKE_TOKENS: "1" },
  });
  return { child, out };
}

function waitExit(child: ServerHandle["child"]): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((r) => child.once("exit", () => r()));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function ppidOf(pid: number): number {
  const out = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim();
  return Number(out);
}

test("执行器不在主服务进程树里，SIGKILL 主服务后仍活着并能被新进程接管", async () => {
  const first = spawnServer("start", "start");
  let started: any;
  try {
    started = await waitFile(first.out);
    assert.equal(typeof started.pid, "number");
    assert.equal(started.session, "ses_reattach");
    assert.equal(alive(started.pid), true);

    // 关键：执行器不是主服务的直接子进程，treekill 按 ppid 找不到它
    const ppid = ppidOf(started.pid);
    assert.notEqual(ppid, first.child.pid, "执行器仍挂在主服务下，pm2 restart 会把它一起杀掉");
    assert.equal(alive(ppid), true, "中间层 reaper 应该还活着");
    assert.equal(ppidOf(ppid), 1, "reaper 应该已被 launchd/init 收养");

    const state = readRunnerState(dataDir, started.task_id);
    assert.ok(state, "缺少 runner.state.json");
    assert.equal(state.pid, started.pid);
    assert.equal(state.status, "running");
    assert.ok(state.boot, "状态文件要记进程启动时间，防 pid 复用");
    assert.ok(state.argv.some((a) => a === "--dangerously-skip-permissions"));
    assert.equal(JSON.stringify(state).includes("RB_API_TOKEN"), false, "状态文件不落 token");
  } finally {
    first.child.kill("SIGKILL");
    await waitExit(first.child);
  }

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(started.pid), true, "主服务被 SIGKILL 后执行器应该还活着");

  // 模拟 pm2 restart 后的新进程：扫一遍 running 任务，应该接管而不是判死
  const second = spawnServer("attach", "attach");
  let attached: any;
  try {
    attached = await waitFile(second.out);
  } finally {
    second.child.kill("SIGKILL");
    await waitExit(second.child);
  }
  assert.deepEqual(attached.sweep.attached, [started.task_id]);
  assert.deepEqual(attached.sweep.dead, []);
  assert.equal(attached.task.runner_pid, started.pid);
  assert.equal(attached.task.status, "running");

  // 等执行器自然退出，再用另一个「新进程」的身份扫一遍：事件 + 退出码 + 用量都要补上
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && alive(started.pid)) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(started.pid), false, "执行器没有按预期退出");

  const store = new Store(dbFile);
  try {
    const r = sweepDeadRunners(store, { dataDir });
    assert.deepEqual(r.dead, [started.task_id]);
    const task = getTask(store, started.task_id)!;
    assert.equal(task.runner_pid, null);
    assert.equal(task.stage, "exited");
    assert.equal(task.exec_total_tokens, 15, "退出后要落用量");
    const events = listTaskEvents(store, started.task_id);
    assert.ok(events.some((e) => /已接回执行器进程/.test(e.text)), "接管时要留痕迹");
    const exitEvent = events.find((e) => /执行器进程已退出/.test(e.text));
    assert.ok(exitEvent, "缺少退出事件");
    assert.match(exitEvent.text, /正常退出/);
    assert.match(exitEvent.text, /pid=/);
    assert.equal(readRunnerState(dataDir, started.task_id)?.status, "exited");
  } finally {
    store.close();
  }
});
