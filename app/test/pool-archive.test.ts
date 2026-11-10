import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { archiveSettledTaskPools, createTask, updateTask } from "../src/core/tasks.ts";
import { appendTaskEvent, listTaskEvents } from "../src/core/task-events.ts";
import { readPool, searchPool } from "../src/ops/pools.ts";
import type { InboundMessage } from "../src/types.ts";

let n = 0;
const msg = (o: Partial<InboundMessage> = {}): InboundMessage => ({
  platform: "feishu", external_chat_id: "oc_1", pool_kind: "private", msg_id: `m${++n}`, sender_id: "ou_a", sender_name: "A",
  ts: Date.now(), text: "hi", reply_to: null, mentions: [], is_mention_me: false, media_type: "text", ...o,
});

test("归档池：默认列表隐藏，历史仍可读；新消息自动解档", () => {
  const s = new Store(":memory:");
  const m = s.insertMessage(msg())!;
  const pid = m.pool_id;

  s.archivePool("p1", true);
  assert.equal(s.getPool(pid)!.archived, true);
  assert.equal(s.listPools().length, 0, "默认列表不返回归档池");
  assert.equal(s.listPools({ includeArchived: true }).length, 1, "显式查询仍能看到");
  assert.deepEqual(s.poolsWithUnread(), [], "归档池不参与唤醒");

  assert.equal(readPool(s, "p1").messages.length, 1, "归档后仍可读历史");
  assert.equal(searchPool(s, "hi", "p1").hits, 1, "归档后仍可按关键词查");

  s.insertMessage(msg({ text: "又来一条" }));
  assert.equal(s.getPool(pid)!.archived, false, "新消息进来自动解档");
  assert.deepEqual(s.poolsWithUnread(), [pid]);

  s.close();
});

test("任务池：终态且读完才自动归档，恢复事件会解档", () => {
  const s = new Store(":memory:");
  const t = createTask(s, { userId: "u1", poolId: "oc_1", name: "#归档测试", goal: "验证归档" });
  const pid = t.task_pool_id;

  updateTask(s, t.id, { status: "running" });
  appendTaskEvent(s, t.id, { text: "阶段 working", sender: "opencode-1", ts: 1000 });
  updateTask(s, t.id, { status: "done" });
  appendTaskEvent(s, t.id, { text: "任务完成", sender: "opencode-1", ts: 2000 });

  assert.deepEqual(archiveSettledTaskPools(s), [], "还有未读时不归档");
  assert.equal(s.getPool(pid)!.archived, false);

  s.advanceCursor(pid, s.maxSeq(pid));
  assert.deepEqual(archiveSettledTaskPools(s), [pid]);
  assert.equal(s.getPool(pid)!.archived, true);
  assert.ok(!s.listPools().some((p) => p.pool_id === pid), "归档后不出现在默认列表");
  assert.equal(listTaskEvents(s, t.id).length, 2, "归档不删历史");

  appendTaskEvent(s, t.id, { text: "恢复执行", sender: "opencode-1", ts: 3000 });
  assert.equal(s.getPool(pid)!.archived, false, "任务池来新事件自动解档");
  assert.deepEqual(s.poolsWithUnread(), [pid]);

  s.close();
});
