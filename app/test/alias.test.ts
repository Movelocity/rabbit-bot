import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAliasContent, findAliases, formatAliases, type Alias } from "../src/core/alias.ts";
import { Store } from "../src/core/db.ts";
import { addMemory, resolveAliases } from "../src/ops/memories.ts";

test("拆「说法 → 指向」：几种箭头都认", () => {
  assert.deepEqual(parseAliasContent("那个项目 → 电商 AI Agent"), { alias: "那个项目", target: "电商 AI Agent" });
  assert.deepEqual(parseAliasContent("老地方 -> 潮汕牛肉火锅"), { alias: "老地方", target: "潮汕牛肉火锅" });
  assert.deepEqual(parseAliasContent("她又来了 => 反复抱怨的加班"), { alias: "她又来了", target: "反复抱怨的加班" });
  assert.deepEqual(parseAliasContent("「大鱼」＝ 我"), { alias: "大鱼", target: "我" });
});

test("格式不对就返回 null，别瞎猜", () => {
  assert.equal(parseAliasContent("那个项目"), null);
  assert.equal(parseAliasContent(" → 只有指向"), null);
  assert.equal(parseAliasContent("只有说法 → "), null);
  assert.equal(parseAliasContent(""), null);
});

test("命中别名，按原文出现顺序返回", () => {
  const aliases: Alias[] = [
    { id: 1, alias: "老地方", target: "潮汕牛肉火锅" },
    { id: 2, alias: "那个项目", target: "电商 Agent" },
  ];
  const hits = findAliases("那个项目那边又催了，周末还是去老地方吧", aliases);
  assert.deepEqual(hits.map((h) => h.id), [2, 1]);
});

test("长别名优先：被整段覆盖的短别名不再单独报", () => {
  const aliases: Alias[] = [
    { id: 1, alias: "那个项目", target: "短指向" },
    { id: 2, alias: "那个项目管理后台", target: "长指向" },
  ];
  const hits = findAliases("那个项目管理后台又挂了", aliases);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 2, "该报更长的那个");
});

test("没提就不报", () => {
  assert.deepEqual(findAliases("今天吃了米饭", [{ id: 1, alias: "老地方", target: "火锅" }]), []);
  assert.deepEqual(findAliases("", [{ id: 1, alias: "老地方", target: "火锅" }]), []);
});

test("一句话里同一个别名只报一次", () => {
  const hits = findAliases("老地方老地方老地方", [{ id: 1, alias: "老地方", target: "火锅" }]);
  assert.equal(hits.length, 1);
});

test("formatAliases 拼成一行人话", () => {
  assert.equal(
    formatAliases([{ id: 1, alias: "老地方", target: "火锅" }, { id: 2, alias: "那个项目", target: "电商" }]),
    "「老地方」= 火锅；「那个项目」= 电商",
  );
});

// ---------- 接线：从库里取 alias 记忆 ----------

function setup() {
  const store = new Store(":memory:");
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_al", pool_kind: "private", msg_id: "m1",
    sender_id: "u1", sender_name: "他", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  return { store, pool: store.listPools()[0].pool_id };
}

test("从库里翻别名：只认 kind=alias，普通事实不参与", () => {
  const { store, pool } = setup();
  addMemory(store, { user: "u1", content: "那个项目 → 电商 AI Agent", pool, kind: "alias" });
  addMemory(store, { user: "u1", content: "他最近在看篮球", pool, kind: "fact" });
  const hits = resolveAliases(store, { user: "u1", pool, text: "那个项目怎么样了" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].target, "电商 AI Agent");
});

test("被 --supersede 顶掉的别名不再生效（改了口就别再按旧的说）", () => {
  const { store, pool } = setup();
  const old = addMemory(store, { user: "u1", content: "那个项目 → 电商 AI Agent", pool, kind: "alias" });
  addMemory(store, { user: "u1", content: "那个项目 → 数字人", pool, kind: "alias", supersede: old.id });
  const hits = resolveAliases(store, { user: "u1", pool, text: "那个项目做好了没" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].target, "数字人");
});

test("别的用户的别名翻不出来", () => {
  const { store, pool } = setup();
  addMemory(store, { user: "u1", content: "老地方 → 潮汕牛肉火锅", pool, kind: "alias" });
  assert.deepEqual(resolveAliases(store, { user: "u2", pool, text: "去老地方" }), []);
});
