// 验证「距上次对话」真的进了唤醒提示语（不调模型，只渲染）
import { Store } from "../src/core/db.js";
import { wakePrompt } from "../src/agent/prompt.js";

const store = new Store("data/rabbit-bot.db");
const pool = store.listPools().find((p) => p.pool_id.startsWith("feishu:"));
if (!pool) throw new Error("没有 feishu 池");

const out = wakePrompt(store, {
  wake: { type: "tick", reasons: ["probe"] } as never,
  now: Date.now(),
  unread: [],
  context: new Map([[pool.pool_id, store.recentMessages(pool.pool_id, 2)]]),
  memories: new Map(),
  plans: [],
  topics: store.pickTopics(pool.pool_id, 2, Date.now()),
});

const tide = out.split("\n").filter((l) => l.includes("上次主动") || l.includes("距上次对话") || l.includes("今天已主动"));
console.log("=== part-tide 三行 ===");
for (const l of tide) console.log(l);
console.log("=== 断言 ===");
console.log("距上次对话 有值:", /距上次对话：\S/.test(out));
console.log("=== 睡眠/提示语尾部 ===");
console.log(out.split("\n").slice(-11).join("\n"));
