import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { createTools } from "../src/agent/tools.ts";
import {
  addKnowledge, archiveKnowledge, getKnowledge, normalizeTags, searchKnowledge, updateKnowledge,
} from "../src/ops/knowledge.ts";

test("知识：add / get / search / update / archive", () => {
  const store = new Store(":memory:");
  const at = 1_700_000_000_000;
  const k = addKnowledge(store, {
    title: "erp-gva 发版",
    body: "后端镜像 3.12GB，慢在 7 个辅助程序各自编整份 ERP。",
    tags: "erp-gva, 发版, erp-gva",
  }, at);
  assert.equal(k!.id, 1);
  assert.deepEqual(k!.tags, ["erp-gva", "发版"]);

  assert.equal(getKnowledge(store, 1).body.includes("3.12GB"), true);
  assert.equal(searchKnowledge(store, { q: "3.12GB" }).length, 1);
  assert.equal(searchKnowledge(store, { tag: "发版" }).length, 1);
  assert.equal(searchKnowledge(store, { tag: "不存在" }).length, 0);

  const updated = updateKnowledge(store, { id: 1, title: "erp-gva 构建优化", tags: "发布" }, at + 1);
  assert.equal(updated!.title, "erp-gva 构建优化");
  assert.deepEqual(updated!.tags, ["发布"]);
  assert.equal(searchKnowledge(store, { q: "构建" }).length, 1);

  archiveKnowledge(store, { id: 1 }, at + 2);
  assert.equal(searchKnowledge(store, { q: "构建" }).length, 0, "归档后默认查不到");
  assert.equal(searchKnowledge(store, { q: "构建", all: true }).length, 1, "all=1 能查归档");
  store.close();
});

test("知识：必填项和标签规范化", () => {
  const store = new Store(":memory:");
  assert.throws(() => addKnowledge(store, { title: "", body: "x" }), /title/);
  assert.throws(() => addKnowledge(store, { title: "x", body: "" }), /body/);
  assert.deepEqual(normalizeTags("a，b、c a"), ["a", "b", "c"]);
  store.close();
});

test("knowledge 工具：一次 add，不建任务也能查回来", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-knowledge-"));
  const cfg = loadConfig({
    dataDir: dir,
    logDir: path.join(dir, "logs"),
    runtimeDir: path.join(dir, "runtime"),
    exec: { dir: path.join(dir, "sandbox") },
  });
  const store = new Store(":memory:");
  const pool = store.upsertPool("mock", "dm-k", "private", "他");
  store.insertMessage({
    platform: "mock", external_chat_id: "dm-k", pool_kind: "private", msg_id: "k1",
    sender_id: "ou_k", sender_name: "他", ts: Date.now(), text: "记一下发版流程",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa",
    primaryPool: () => pool.pool_id,
    currentUnread: () => store.unread(pool.pool_id),
  }) as any[];
  const knowledge = tools.find((t) => t.name === "knowledge")!;
  const add: any = await knowledge.execute("id", {
    action: "add", title: "发版流程", body: "先构建镜像，再跑 compose。", tags: "erp-gva,发版",
  });
  assert.equal(add.details?.ok, true, JSON.stringify(add.details));
  assert.equal(add.details?.id, 1);

  const search: any = await knowledge.execute("id", { action: "search", q: "compose" });
  assert.equal(search.details?.ok, true);
  assert.match(search.content.map((c: any) => c.text ?? "").join(""), /发版流程/);

  const get: any = await knowledge.execute("id", { action: "get", id: 1 });
  assert.match(get.content.map((c: any) => c.text ?? "").join(""), /先构建镜像/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
