/** 一次性进程派发：任务文档、命令参数、session 抓取、pid 落库、resume -s、stop。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { createTools } from "../src/agent/tools.ts";
import { createTask, getTask, updateTask } from "../src/core/tasks.ts";
import { completeTask } from "../src/core/workers.ts";
import { listTaskEvents } from "../src/core/task-events.ts";
import {
  buildOpencodeArgs, isRunnerAlive, resumeTask, startTask, stopTask, sweepDeadRunners, writeTaskDoc,
} from "../src/core/dispatch.ts";

const root = path.join(APP_ROOT, ".scratch", "dispatch-test");
const workDir = path.join(root, "work");
const runtimeDir = path.join(root, "runtime");
const fakeBin = path.join(root, "fake-exec.mjs");
fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(fakeBin, `#!/usr/bin/env node
import fs from "node:fs";
const out = process.env.FAKE_EXEC_OUT;
if (out) {
  const tmp = out + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: {
      RB_API_BASE: process.env.RB_API_BASE, RB_API_TOKEN: process.env.RB_API_TOKEN,
      RB_TASK_DIR: process.env.RB_TASK_DIR, RB_TASK_DOC: process.env.RB_TASK_DOC,
    },
  }));
  fs.renameSync(tmp, out);
}
const sid = process.env.FAKE_EXEC_SESSION || "ses_fake_123";
if (process.env.FAKE_EXEC_FIELD === "codex") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: sid }));
} else if (process.env.FAKE_EXEC_FIELD === "claude") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
} else {
  console.log(JSON.stringify({ type: "step_start", sessionID: sid }));
}
if (process.env.FAKE_EXEC_TOKENS) {
  if (process.env.FAKE_EXEC_FIELD === "codex") {
    console.log(JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 1,
      output_tokens: 5, reasoning_output_tokens: 0,
    } }));
  } else if (process.env.FAKE_EXEC_FIELD === "claude") {
    console.log(JSON.stringify({ type: "result", subtype: "success", num_turns: 2, duration_ms: 1200, total_cost_usd: 0.004, usage: {
      input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 5,
    } }));
  } else {
    console.log(JSON.stringify({ type: "step_finish", timestamp: Date.now(), part: {
      tokens: { input: 10, output: 5, reasoning: 0, total: 15, cache: { read: 2, write: 1 } },
      cost: 0.001,
    } }));
  }
}
const sleep = Number(process.env.FAKE_EXEC_SLEEP || 30);
setTimeout(() => process.exit(0), sleep);
`, "utf8");
fs.chmodSync(fakeBin, 0o755);

let seq = 0;
const recordPath = () => path.join(root, `record-${process.pid}-${++seq}.json`);

/** resume 不等执行器写完参数就返回；测试读记录前等一下，别和子进程抢。 */
async function readRecord(file: string, timeoutMs = 3000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function setup() {
  const store = new Store(":memory:");
  const task = createTask(store, {
    userId: "u1",
    poolId: "p1",
    name: "#纪要",
    goal: "整理会议纪要",
    deliverable: "notes.md",
    constraints: "只改工作目录",
    acceptance: "notes.md 有结论",
    files: ["a.txt"],
    work_dir: workDir,
    executor: "opencode",
  });
  return { store, task };
}

test("writeTaskDoc：生成任务文档、回填 doc_path、只引用环境变量不落明文 token", () => {
  const { store, task } = setup();
  const legacyDoc = path.join(workDir, ".ufa", "tasks", `task-${task.id}.md`);
  fs.mkdirSync(path.dirname(legacyDoc), { recursive: true });
  fs.writeFileSync(legacyDoc, "old doc\n");
  const docPath = writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  assert.equal(docPath, path.join(runtimeDir, ".ufa", "tasks", `task-${task.id}.md`));
  assert.equal(fs.existsSync(docPath), true);
  assert.equal(getTask(store, task.id)?.doc_path, docPath);
  assert.equal(fs.existsSync(legacyDoc), false, "旧位置的任务文档要清掉");

  const text = fs.readFileSync(docPath, "utf8");
  assert.match(text, /整理会议纪要/);
  assert.match(text, /notes\.md/);
  assert.match(text, /只改工作目录/);
  assert.match(text, /notes\.md 有结论/);
  assert.match(text, /a\.txt/);
  assert.match(text, new RegExp(workDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // 文档自带目录核对规则：当前目录不是 work_dir 就直接结束任务
  assert.match(text, /pwd -P/);
  assert.match(text, /realpath/);
  assert.match(text, /结束任务/);
  assert.match(text, new RegExp(`# 任务 #${task.id}`));
  assert.match(text, new RegExp(`/v1/tasks/${task.id}/progress`));
  assert.match(text, new RegExp(`/v1/tasks/${task.id}/complete`));
  assert.match(text, new RegExp(`/v1/tasks/${task.id}/fail`));
  assert.equal(text.includes("/v1/approvals"), false);
  assert.match(text, /执行阶段没有运行时审批/);
  assert.match(text, /不得越出工作目录/);
  assert.match(text, /\$RB_API_TOKEN/);
  assert.match(text, /\$RB_API_BASE/);
  assert.match(text, new RegExp(`"worker_id":"opencode-${task.id}"`));
  assert.match(text, /调用一次 progress/);
  assert.match(text, /不要改工作目录之外的文件/);
  // 不能出现任何 token 值：文档里只有变量名
  assert.equal(text.includes("secret-token-value"), false);
  store.close();
});

test("startTask：命令参数、env、cwd、session_id、pid 落库、首条任务池事件", async () => {
  const { store, task } = setup();
  const docPath = writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  const out = recordPath();
  process.env.FAKE_EXEC_OUT = out;
  delete process.env.FAKE_EXEC_SLEEP;

  const result = await startTask(store, task, {
    apiBase: "http://127.0.0.1:9999",
    token: "secret-token-value",
    dataDir: root,
    runtimeDir,
    executorBin: fakeBin,
  });

  assert.equal(result.session_id, "ses_fake_123");
  assert.equal(result.captured, true);
  assert.equal(typeof result.pid, "number");

  const record = await readRecord(out);
  const argv: string[] = record.argv;
  assert.equal(argv[0], "run");
  assert.equal(argv[1], `读 ${docPath} 并执行`);
  // 显式 executorBin（测试假执行器）不做版本探测，走旧的兜底参数：
  // 工作目录由 spawn 的 cwd 决定，不带 --dir / --directory。
  assert.equal(argv.includes("--dir"), false, `argv 不该带 --dir：${argv.join(" ")}`);
  assert.equal(argv.includes("--directory"), false, `argv 不该带 --directory：${argv.join(" ")}`);
  assert.ok(argv.includes("--title"));
  assert.equal(argv[argv.indexOf("--title") + 1], `#${task.id} 纪要`);
  assert.ok(argv.includes("--format"));
  assert.equal(argv[argv.indexOf("--format") + 1], "json");
  assert.ok(argv.includes("--dangerously-skip-permissions"), `opencode 启动参数缺无审批 flag：${argv.join(" ")}`);
  assert.equal(argv.includes("-s"), false, "新任务不该带 -s");
  assert.equal(record.cwd, workDir);
  assert.equal(record.env.RB_API_BASE, "http://127.0.0.1:9999");
  assert.equal(record.env.RB_API_TOKEN, "secret-token-value");
  assert.equal(record.env.RB_TASK_DOC, docPath);
  assert.equal(record.env.RB_TASK_DIR, path.join(runtimeDir, ".ufa", "work", `task-${task.id}`));

  const fresh = getTask(store, task.id)!;
  assert.equal(fresh.session_id, "ses_fake_123");
  assert.equal(fresh.runner_pid, result.pid);
  assert.equal(typeof fresh.runner_started_at, "number");
  assert.equal(fresh.status, "running");
  assert.equal(fresh.worker_id, `opencode-${task.id}`);
  assert.equal(fresh.doc_path, docPath);

  const runnerLog = path.join(root, "tasks", String(task.id), "runner.jsonl");
  const logText = fs.readFileSync(runnerLog, "utf8");
  assert.match(logText, /ses_fake_123/);
  assert.match(logText, /--dangerously-skip-permissions/);
  assert.equal(logText.includes("secret-token-value"), false, "runner 日志不能落 token");

  const events = listTaskEvents(store, task.id, { limit: 1 });
  assert.match(events[0].text, /已启动 opencode/);
  assert.match(events[0].text, /session 已捕获/);
  assert.equal(events[0].text.includes("工作目录"), false);
  assert.equal(events[0].text.includes("ses_fake_123"), false);
  store.close();
});

test("进程自然退出：写事件、清 runner_pid、stage=exited", async () => {
  const { store, task } = setup();
  writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  process.env.FAKE_EXEC_OUT = recordPath();
  process.env.FAKE_EXEC_SLEEP = "20";
  await startTask(store, task, {
    apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
  });
  const deadline = Date.now() + 3000;
  let events = listTaskEvents(store, task.id);
  while (Date.now() < deadline && !events.some((e) => /执行器进程已退出/.test(e.text))) {
    await new Promise((r) => setTimeout(r, 20));
    events = listTaskEvents(store, task.id);
  }
  const exitEvent = events.find((e) => /执行器进程已退出/.test(e.text));
  assert.ok(exitEvent, `没记到退出：${events.map((e) => e.text).join(" | ")}`);
  assert.match(exitEvent.text, /正常退出/);
  const fresh = getTask(store, task.id)!;
  assert.equal(fresh.runner_pid, null);
  assert.equal(fresh.stage, "exited");
  store.close();
});

test("startTask：model 分别走 -m / --model", async () => {
  const { store, task } = setup();
  writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  const out = recordPath();
  process.env.FAKE_EXEC_OUT = out;
  const t = getTask(store, task.id)!;
  updateTask(store, t.id, { model: "provider/model-a" });
  await startTask(store, getTask(store, t.id)!, {
    apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
  });
  const argv: string[] = (await readRecord(out)).argv;
  assert.equal(argv[argv.indexOf("-m") + 1], "provider/model-a");

  const { store: store2, task: task2 } = setup();
  writeTaskDoc(store2, task2, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  const out2 = recordPath();
  process.env.FAKE_EXEC_OUT = out2;
  updateTask(store2, task2.id, { executor: "mimo", model: "provider/model-b" });
  await startTask(store2, getTask(store2, task2.id)!, {
    apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
  });
  const argv2: string[] = (await readRecord(out2)).argv;
  assert.equal(argv2[argv2.indexOf("--model") + 1], "provider/model-b");
  assert.equal(argv2.includes("-m"), false);
  assert.ok(argv2.includes("--dangerously-skip-permissions"), `mimo 启动参数缺无审批 flag：${argv2.join(" ")}`);
  store.close();
  store2.close();
});

test("opencode 参数按版本能力拼：老版本认 --dir/--auto，新版本不认 --dir 时退回全局 --directory", () => {
  const task = {
    id: 7, name: "#纪要", goal: "整理会议纪要", executor: "opencode",
    model: "provider/model-a", work_dir: workDir, session_id: "ses_old",
  } as any;

  // 旧版：run 认 --dir，无审批 --auto。
  const oldArgs = buildOpencodeArgs(task, "读 doc 并执行", false, {
    dir: true, directory: false, session: "long", model: "long",
    title: true, formatJson: true, permission: "--auto",
  });
  assert.deepEqual(oldArgs, [
    "run", "--dir", workDir, "读 doc 并执行",
    "--title", "#7 纪要", "--format", "json", "--model", "provider/model-a", "--auto",
  ]);

  // 新版：run 不认 --dir，目录走全局 --directory；无审批换回旧 flag。
  const newArgs = buildOpencodeArgs(task, "继续任务，先读 doc", true, {
    dir: false, directory: true, session: "short", model: "short",
    title: true, formatJson: true, permission: "--dangerously-skip-permissions",
  });
  assert.deepEqual(newArgs, [
    "--directory", workDir, "run", "继续任务，先读 doc", "-s", "ses_old",
    "--title", "#7 纪要", "--format", "json", "-m", "provider/model-a",
    "--dangerously-skip-permissions",
  ]);
  assert.equal(newArgs.includes("--dir"), false, "不认 --dir 的版本不能带，否则会秒退");
});

test("opencode 参数探测失败时保持旧行为；版本不支持恢复会话时明确报错", () => {
  const task = {
    id: 8, name: "#长任务", goal: "跑很久", executor: "opencode",
    model: "", work_dir: workDir, session_id: "ses_old",
  } as any;

  const legacy = buildOpencodeArgs(task, "读 doc 并执行", true, null);
  assert.deepEqual(legacy, [
    "run", "读 doc 并执行", "-s", "ses_old", "--title", "#8 长任务",
    "--format", "json", "--dangerously-skip-permissions",
  ]);

  assert.throws(
    () => buildOpencodeArgs(task, "继续", true, {
      dir: false, directory: false, session: null, model: null,
      title: true, formatJson: true, permission: null,
    }),
    /不支持恢复会话/,
  );
});

test("startTask / resumeTask：codex 用 exec --json、-C 工作目录，并从 thread_id 抓 session", async () => {
  const { store, task } = setup();
  const docPath = writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  const out = recordPath();
  process.env.FAKE_EXEC_OUT = out;
  process.env.FAKE_EXEC_FIELD = "codex";
  delete process.env.FAKE_EXEC_SLEEP;
  updateTask(store, task.id, { executor: "codex", model: "gpt-5-codex" });
  try {
    const result = await startTask(store, getTask(store, task.id)!, {
      apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
    });
    const argv: string[] = (await readRecord(out)).argv;
    assert.equal(argv[0], "exec");
    assert.ok(argv.includes("--json"));
    assert.ok(argv.includes("--skip-git-repo-check"));
    assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.equal(argv[argv.indexOf("-C") + 1], workDir);
    assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5-codex");
    assert.equal(argv[argv.length - 1], `读 ${docPath} 并执行`);
    assert.equal(argv.includes("resume"), false, "新任务不该带 resume");
    assert.equal(result.session_id, "ses_fake_123");
    assert.equal(getTask(store, task.id)?.worker_id, `codex-${task.id}`);

    const out2 = recordPath();
    process.env.FAKE_EXEC_OUT = out2;
    const resumed = await resumeTask(store, getTask(store, task.id)!, {
      apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
    });
    const argv2: string[] = (await readRecord(out2)).argv;
    const at = argv2.indexOf("resume");
    assert.ok(at > 0, `codex resume 参数缺子命令：${argv2.join(" ")}`);
    assert.equal(argv2[at + 1], "ses_fake_123");
    assert.equal(argv2[at + 2], `继续任务，先读 ${docPath}`);
    assert.equal(resumed.session_id, "ses_fake_123");
  } finally {
    delete process.env.FAKE_EXEC_FIELD;
    store.close();
  }
});

test("startTask / resumeTask：claude 用 -p stream-json，从 system/session_id 抓 session，并带 --resume", async () => {
  const { store, task } = setup();
  const docPath = writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  const out = recordPath();
  process.env.FAKE_EXEC_OUT = out;
  process.env.FAKE_EXEC_FIELD = "claude";
  delete process.env.FAKE_EXEC_SLEEP;
  updateTask(store, task.id, { executor: "claude", model: "claude-sonnet-4-5" });
  try {
    const result = await startTask(store, getTask(store, task.id)!, {
      apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
    });
    const argv: string[] = (await readRecord(out)).argv;
    assert.equal(argv[0], "-p");
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
    assert.ok(argv.includes("--verbose"));
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(argv[argv.indexOf("--disallowedTools") + 1], "AskUserQuestion");
    assert.equal(argv[argv.indexOf("--model") + 1], "claude-sonnet-4-5");
    assert.equal(argv[argv.length - 1], `读 ${docPath} 并执行`);
    assert.equal(argv.includes("--resume"), false, "新任务不该带 --resume");
    assert.equal(result.session_id, "ses_fake_123");
    assert.equal(getTask(store, task.id)?.worker_id, `claude-${task.id}`);

    const out2 = recordPath();
    process.env.FAKE_EXEC_OUT = out2;
    const resumed = await resumeTask(store, getTask(store, task.id)!, {
      apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
    });
    const argv2: string[] = (await readRecord(out2)).argv;
    const at = argv2.indexOf("--resume");
    assert.ok(at > 0, `claude resume 参数缺 --resume：${argv2.join(" ")}`);
    assert.equal(argv2[at + 1], "ses_fake_123");
    assert.equal(argv2[argv2.length - 1], `继续任务，先读 ${docPath}`);
    assert.equal(resumed.session_id, "ses_fake_123");
  } finally {
    delete process.env.FAKE_EXEC_FIELD;
    store.close();
  }
});

test("resumeTask：用同一个 session id 带 -s，提示词要求先读任务文档", async () => {
  const { store, task } = setup();
  const docPath = writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  process.env.FAKE_EXEC_OUT = recordPath();
  updateTask(store, task.id, { session_id: "ses_keep_me" });

  const out = recordPath();
  process.env.FAKE_EXEC_OUT = out;
  const result = await resumeTask(store, getTask(store, task.id)!, {
    apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
  });

  assert.equal(result.session_id, "ses_keep_me");
  const argv: string[] = (await readRecord(out)).argv;
  assert.equal(argv[0], "run");
  assert.equal(argv[1], `继续任务，先读 ${docPath}`);
  assert.equal(argv[argv.indexOf("-s") + 1], "ses_keep_me");
  assert.equal(getTask(store, task.id)?.session_id, "ses_keep_me");
  const events = listTaskEvents(store, task.id, { limit: 1 });
  assert.match(events[0].text, /恢复执行/);
  assert.equal(events[0].text.includes("工作目录"), false);
  assert.equal(events[0].text.includes("ses_keep_me"), false);
  store.close();
});

test("resumeTask：没有 session_id 直接报错", async () => {
  const { store, task } = setup();
  writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  await assert.rejects(
    () => resumeTask(store, task, { apiBase: "http://x", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin }),
    /session_id/,
  );
  store.close();
});

test("UFA task create：只登记 pending_approval，等 Web 审批，不产生 runner", async () => {
  const cfg = loadConfig();
  const store = new Store(":memory:");
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_dispatch", pool_kind: "private", msg_id: "m1",
    sender_id: "ou_1", sender_name: "他", ts: Date.now(), text: "干活",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0].pool_id;
  const createScope = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const out = path.join(root, "ufa-create", `${createScope}.json`);
  const createDataDir = path.join(root, "ufa-create", createScope);
  process.env.FAKE_EXEC_OUT = out;
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(), primaryPool: () => pool,
    profile: "ufa",
    dispatch: { apiBase: "http://127.0.0.1:9999", token: "tok", dataDir: createDataDir, executorBin: fakeBin },
  }) as any[];
  const taskTool = tools.find((t) => t.name === "task");

  const r = await taskTool.execute("id", { action: "create", name: "#报告", goal: "写一份报告", work_dir: workDir });
  assert.equal(r.details?.ok, true, JSON.stringify(r.details));
  assert.match(r.content?.[0]?.text ?? "", /等待 Web 审批/);
  const fresh = getTask(store, r.details.task.id)!;
  assert.equal(fresh.status, "pending_approval");
  assert.equal(fresh.executor, "opencode");
  assert.equal(fresh.session_id, "");
  assert.equal(fresh.runner_pid, null);
  assert.equal(fresh.doc_path, "");
  assert.equal(fs.existsSync(out), false, "建任务阶段不该启动执行器");
  assert.equal(fs.existsSync(path.join(createDataDir, "tasks", String(fresh.id), "runner.jsonl")), false);
  store.close();
});

test("stopTask：杀进程树、清 runner_pid、running 回到 pending，并落耗时/token", async () => {
  const { store, task } = setup();
  writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  process.env.FAKE_EXEC_OUT = recordPath();
  process.env.FAKE_EXEC_SLEEP = "10000";
  process.env.FAKE_EXEC_TOKENS = "1";
  fs.rmSync(path.join(root, "tasks", String(task.id)), { recursive: true, force: true });
  try {
    const started = await startTask(store, task, {
      apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
    });
    assert.equal(typeof started.pid, "number");
    assert.equal(isRunnerAlive(started.pid), true);

    const stopped = await stopTask(store, getTask(store, task.id)!, { graceMs: 2000, dataDir: root });
    assert.equal(stopped.runner_pid, null);
    assert.equal(stopped.runner_started_at, null);
    assert.equal(stopped.status, "pending");
    assert.equal(isRunnerAlive(started.pid), false);
    assert.ok(stopped.exec_usage_at, "关闭时要落 exec_usage_at");
    assert.equal(stopped.exec_total_tokens, 15);
    assert.ok(stopped.exec_duration_ms > 0, "要有实际运行耗时");
    const events = listTaskEvents(store, task.id, { limit: 1 });
    assert.match(events[0].text, /已停止执行/);
  } finally {
    delete process.env.FAKE_EXEC_SLEEP;
    delete process.env.FAKE_EXEC_TOKENS;
  }
  store.close();
});

test("sweepDeadRunners：进程没了就清 runner 状态并在任务池发调度器消息", () => {
  const { store, task } = setup();
  updateTask(store, task.id, {
    status: "running", stage: "working", runner_pid: 999999, runner_started_at: Date.now(),
  });
  const r = sweepDeadRunners(store, { dataDir: root });
  assert.equal(r.checked, 1);
  assert.deepEqual(r.dead, [task.id]);
  const fresh = getTask(store, task.id)!;
  assert.equal(fresh.runner_pid, null);
  assert.equal(fresh.runner_started_at, null);
  assert.equal(fresh.stage, "exited");
  const ev = listTaskEvents(store, task.id).find((e) => /执行器进程已退出/.test(e.text));
  assert.ok(ev, "任务池里没有退出消息");
  assert.match(ev.text, /巡检发现进程不存在/);
  assert.match(ev.text, /pid=999999/);
  assert.equal(ev.sender, "调度器");
  store.close();
});

test("sweepDeadRunners：进程还活着不动，重复扫也不会重复写消息", () => {
  const { store, task } = setup();
  updateTask(store, task.id, { status: "running", runner_pid: process.pid, runner_started_at: Date.now() });
  assert.deepEqual(sweepDeadRunners(store).dead, []);
  assert.equal(getTask(store, task.id)!.runner_pid, process.pid);

  updateTask(store, task.id, { runner_pid: 999999 });
  assert.deepEqual(sweepDeadRunners(store).dead, [task.id]);
  const before = listTaskEvents(store, task.id).length;
  assert.deepEqual(sweepDeadRunners(store).dead, []);
  assert.equal(listTaskEvents(store, task.id).length, before);
  store.close();
});

test("任务先 complete、执行器后退出：watcher 仍要清 runner_pid 并落用量", async () => {
  const { store, task } = setup();
  writeTaskDoc(store, task, { apiBase: "http://127.0.0.1:9999", runtimeDir });
  process.env.FAKE_EXEC_OUT = recordPath();
  process.env.FAKE_EXEC_SLEEP = "800";
  process.env.FAKE_EXEC_TOKENS = "1";
  fs.rmSync(path.join(root, "tasks", String(task.id)), { recursive: true, force: true });
  try {
    const started = await startTask(store, task, {
      apiBase: "http://127.0.0.1:9999", token: "t", dataDir: root, runtimeDir, executorBin: fakeBin,
    });
    assert.equal(typeof started.pid, "number");
    // 执行器还在跑的时候先把任务标成 done：后续退出事件不能把任务状态改回去
    const done = completeTask(store, task.id, { workerId: `opencode-${task.id}`, result: "做完了" });
    assert.equal(done.status, "done");
    assert.equal(done.runner_pid, started.pid, "complete 不负责杀进程，pid 先留着");

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && getTask(store, task.id)?.runner_pid !== null) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const fresh = getTask(store, task.id)!;
    assert.equal(fresh.runner_pid, null, "执行器退出后 watcher 要清 pid");
    assert.equal(fresh.status, "done", "退出事件不能把已完成任务改回 running");
    assert.equal(fresh.exec_total_tokens, 15, "complete 之后的退出也要落用量");
    const exitEvent = listTaskEvents(store, task.id).find((e) => /执行器进程已退出/.test(e.text));
    assert.ok(exitEvent, "缺少退出事件");
    assert.match(exitEvent.text, /正常退出/);
  } finally {
    delete process.env.FAKE_EXEC_SLEEP;
    delete process.env.FAKE_EXEC_TOKENS;
  }
  store.close();
});
