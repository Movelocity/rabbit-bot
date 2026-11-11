/** 任务发布审批：发到审批房、贴对表情才裁决、超时=拒绝、多任务不串批。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTask, getTask, updateTask } from "../src/core/tasks.ts";
import { Store } from "../src/core/db.ts";
import { TaskApprovalGate, formatTaskApprovalText, type TaskApprovalConfig } from "../src/core/task-approval.ts";
import type { InboundMessage } from "../src/types.ts";

const ROOM = "oc_approval";
const OWNER = "ou_owner";

function fakeLog() {
  const lines: string[] = [];
  return { lines, log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } as any };
}

function cfg(over: Partial<TaskApprovalConfig> = {}): TaskApprovalConfig {
  return { enabled: true, platform: "feishu", roomId: ROOM, ownerIds: [OWNER], timeoutMs: 3000, ...over };
}

function setup(over: Partial<TaskApprovalConfig> = {}, hooks?: any) {
  const store = new Store(":memory:");
  const task = createTask(store, {
    userId: "u1", poolId: "p1", name: "#修复登录", goal: "把登录页修好",
    work_dir: "/tmp", deliverable: "可登录", acceptance: "能登进去",
    status: "pending_approval",
  });
  const sent: { chatId: string; text: string }[] = [];
  const calls: string[] = [];
  const gate = new TaskApprovalGate(
    cfg(over),
    fakeLog().log,
    async (target, text) => { sent.push({ chatId: target.chatId, text }); return { ok: true, msgId: `om_prompt_${task.id}` }; },
    hooks ?? {
      onApprove: async (_t: any, by: string) => { calls.push(`approve:${by}`); return { ok: true, text: "#已批准" }; },
      onReject: async (_t: any, by: string) => { calls.push(`reject:${by}`); return { ok: true, text: "#已拒绝" }; },
      onTimeout: async () => { calls.push("timeout"); return { ok: true, text: "#已超时" }; },
    },
  );
  return { store, task, sent, calls, gate };
}

function react(key: string, to: string | null, over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "feishu",
    external_chat_id: ROOM,
    pool_kind: "group",
    msg_id: `reaction:${Math.random()}`,
    sender_id: OWNER,
    sender_name: "主人",
    ts: Date.now(),
    text: key,
    reply_to: to,
    reaction_to: to,
    mentions: [],
    is_mention_me: false,
    media_type: "reaction",
    reaction_key: key,
    from_self: false,
    ...over,
  };
}

test("任务提示包含完整标题、目标和审批方法，不塞产出/约束/验收", () => {
  const store = new Store(":memory:");
  const task = createTask(store, {
    userId: "u1", poolId: "p1", name: "#修复登录", goal: "把登录页修好",
    deliverable: "可登录", constraints: "不要改注册", acceptance: "能登进去",
    work_dir: "/tmp/project", executor: "opencode", status: "pending_approval",
  });
  const text = formatTaskApprovalText(task, 24 * 3600_000);
  assert.match(text, /【任务待审批】#\d+ #修复登录/);
  assert.match(text, /目标：把登录页修好/);
  assert.match(text, /目录：\/tmp\/project/);
  assert.match(text, /OK \/ 👍 表情/);
  assert.match(text, /超时 1 天/);
  assert.doesNotMatch(text, /产出|约束|验收/);
  assert.doesNotMatch(text, /可登录|不要改注册|能登进去/);
});

test("标题完整保留，name 里重复的任务号只显示一次", () => {
  const store = new Store(":memory:");
  const task = createTask(store, {
    userId: "u1", poolId: "p1", name: "#临时", goal: "查清楚",
    work_dir: "/tmp", status: "pending_approval",
  });
  const fullName = `#${task.id} 排查 SKU THO010034-0 算价失败原因`;
  const updated = updateTask(store, task.id, { name: fullName });
  assert.equal(getTask(store, task.id)?.name, fullName);
  const text = formatTaskApprovalText(updated, 3600_000);
  const first = text.split("\n")[0];
  assert.equal(first, `【任务待审批】#${task.id} 排查 SKU THO010034-0 算价失败原因`);
});

test("关掉时什么都不发，也不留待审", async () => {
  const { gate, sent, task } = setup({ enabled: false });
  assert.equal(gate.enabled, false);
  assert.equal(await gate.notify(task), false);
  assert.equal(sent.length, 0);
  assert.deepEqual(gate.waiting, []);
});

test("开启后发到审批房，并记下待审任务", async () => {
  const { gate, sent, task } = setup();
  assert.equal(await gate.notify(task), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, ROOM);
  assert.match(sent[0].text, /#修复登录/);
  assert.deepEqual(gate.waiting, [task.id]);
});

test("贴 OK 表情批准，回一条状态到审批房", async () => {
  const { gate, sent, calls, task } = setup();
  await gate.notify(task);
  assert.equal(gate.tryHandle(react("OK", `om_prompt_${task.id}`)), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [`approve:${OWNER}`]);
  assert.deepEqual(gate.waiting, []);
  assert.ok(sent.some((s) => s.text === "#已批准"));
});

test("贴 No 表情拒绝", async () => {
  const { gate, calls, task } = setup();
  await gate.notify(task);
  assert.equal(gate.tryHandle(react("No", `om_prompt_${task.id}`)), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [`reject:${OWNER}`]);
});

test("表情贴到别的消息上不算数", async () => {
  const { gate, calls, task } = setup();
  await gate.notify(task);
  assert.equal(gate.tryHandle(react("OK", "om_some_other")), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(gate.waiting, [task.id]);
});

test("非主人贴表情不算数", async () => {
  const { gate, calls, task } = setup();
  await gate.notify(task);
  assert.equal(gate.tryHandle(react("OK", `om_prompt_${task.id}`, { sender_id: "ou_stranger" })), false);
  assert.deepEqual(calls, []);
});

test("超时＝拒绝：调用 onTimeout，并回状态", async () => {
  const { gate, sent, calls, task } = setup({ timeoutMs: 1000 });
  await gate.notify(task);
  await new Promise((r) => setTimeout(r, 1100));
  assert.deepEqual(calls, ["timeout"]);
  assert.deepEqual(gate.waiting, []);
  assert.ok(sent.some((s) => s.text === "#已超时"));
});

test("多条待审时，表情只裁决它贴着的那条", async () => {
  const store = new Store(":memory:");
  const a = createTask(store, { userId: "u", poolId: "p", name: "#一", goal: "甲", work_dir: "/tmp", status: "pending_approval" });
  const b = createTask(store, { userId: "u", poolId: "p", name: "#二", goal: "乙", work_dir: "/tmp", status: "pending_approval" });
  const decided: number[] = [];
  const gate = new TaskApprovalGate(
    cfg(),
    fakeLog().log,
    async (_target, _text) => ({ ok: true, msgId: _text.includes("#一") ? "om_a" : "om_b" }),
    {
      onApprove: (t) => { decided.push(t.id); return { ok: true }; },
      onReject: (t) => { decided.push(t.id); return { ok: true }; },
      onTimeout: () => ({ ok: true }),
    },
  );
  await gate.notify(a);
  await gate.notify(b);
  assert.equal(gate.tryHandle(react("OK", "om_b")), true);
  assert.deepEqual(decided, [b.id]);
  assert.deepEqual(gate.waiting, [a.id]);
});

test("发不出去就不留待审，任务还在但需要换条路批", async () => {
  const store = new Store(":memory:");
  const task = createTask(store, { userId: "u", poolId: "p", name: "#x", goal: "x", work_dir: "/tmp", status: "pending_approval" });
  const gate = new TaskApprovalGate(cfg(), fakeLog().log, async () => ({ ok: false, error: "no adapter" }), {
    onApprove: () => ({ ok: true }), onReject: () => ({ ok: true }), onTimeout: () => ({ ok: true }),
  });
  assert.equal(await gate.notify(task), false);
  assert.deepEqual(gate.waiting, []);
  assert.equal(getTask(store, task.id)?.status, "pending_approval");
});

test("cancel 清掉待审，之后贴表情不再裁决", async () => {
  const { gate, calls, task } = setup();
  await gate.notify(task);
  gate.cancel(task.id);
  assert.deepEqual(gate.waiting, []);
  assert.equal(gate.tryHandle(react("OK", `om_prompt_${task.id}`)), false);
  assert.deepEqual(calls, []);
});
