/** plan 工具：md 看板（新建、勾选目标、进展、归档）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../src/agent/tools.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";
import { getBoard, listBoards } from "../src/core/board.ts";
import { boardDir } from "../src/core/runtime.ts";

const NOW = Date.parse("2026-11-11T03:00:00Z"); // 上海 11:00

function setup() {
  const cfg = loadConfig({ runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-plan-")) });
  const store = new Store(":memory:");
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_plan", pool_kind: "private", msg_id: "m1",
    sender_id: "ou_1", sender_name: "他", ts: NOW, text: "提醒我一下",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  const pool = store.listPools()[0]?.pool_id ?? null;
  const tools = createTools({ store, hub: {} as any, cfg, now: () => NOW, primaryPool: () => pool, profile: "ufa" }) as any[];
  return { cfg, store, plan: tools.find((t) => t.name === "plan") };
}

const text = (r: any): string => r.content[0].text;

test("create → list → goal-check：目标落 md 并能勾上", async () => {
  const { cfg, plan } = setup();
  const created = await plan.execute("t1", {
    action: "create", title: "回看刊登单", background: "单子卡在审核", goals: ["查 state", "回报结果"],
  });
  assert.match(text(created), /建好了/);
  const slug = created.details.plan.slug;

  const list = await plan.execute("t2", { action: "list" });
  assert.match(text(list), /回看刊登单/);
  assert.match(text(list), /目标 0\/2/);

  const checked = await plan.execute("t3", { action: "goal-check", id: slug, goal: "查 state" });
  assert.match(text(checked), /目标 1\/2 完成/);

  const md = fs.readFileSync(path.join(boardDir(cfg), `${slug}.md`), "utf8");
  assert.match(md, /- \[x\] 查 state/);
  assert.match(md, /- \[ \] 回报结果/);
});

test("空看板不把占位文字当成目标/进展", async () => {
  const { cfg, plan } = setup();
  const created = await plan.execute("t1", { action: "create", title: "空计划" });
  const b = getBoard(boardDir(cfg), created.details.plan.slug)!;
  assert.equal(b.background, "");
  assert.equal(b.goals.length, 0);
  assert.equal(b.progress.length, 0);
});

test("同名计划不重复建", async () => {
  const { plan } = setup();
  await plan.execute("t1", { action: "create", title: "回看刊登单" });
  const second = await plan.execute("t2", { action: "create", title: "回看刊登单" });
  assert.equal(second.details?.duplicate, true);
  assert.match(text(second), /已经有一条同名计划/);
});

test("progress 追加，done=false 取消勾选", async () => {
  const { plan } = setup();
  const created = await plan.execute("t1", { action: "create", title: "整理清单", goals: ["主表", "分表"] });
  const slug = created.details.plan.slug;
  await plan.execute("t2", { action: "goal-check", id: slug, goal: "1" });
  const off = await plan.execute("t3", { action: "goal-check", id: slug, goal: "1", done: false });
  assert.match(text(off), /取消勾选/);
  const p = await plan.execute("t4", { action: "progress", id: slug, note: "主表已出" });
  assert.match(text(p), /进展记下了/);

  const show = await plan.execute("t5", { action: "show", id: slug });
  assert.match(text(show), /主表已出/);
});

test("归档后不在默认列表", async () => {
  const { cfg, plan } = setup();
  const created = await plan.execute("t1", { action: "create", title: "临时计划" });
  const slug = created.details.plan.slug;
  const archived = await plan.execute("t2", { action: "archive", id: slug });
  assert.match(text(archived), /已归档/);
  assert.equal(listBoards(boardDir(cfg), "active").length, 0);
  assert.ok(fs.existsSync(path.join(boardDir(cfg), "archive")));
});
