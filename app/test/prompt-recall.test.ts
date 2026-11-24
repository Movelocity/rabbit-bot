import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import {
  containsTerm, matchKnowledge, matchObjects, recallBlock,
  type RecallKnowledge, type RecallObject,
} from "../src/agent/recall.ts";

test("containsTerm：ASCII 词按边界，中文按子串", () => {
  assert.equal(containsTerm("我们用 erp-gva 发版", "erp-gva"), true);
  assert.equal(containsTerm("这台是 erp-gvax", "erp-gva"), false);
  assert.equal(containsTerm("跑一下发版流程", "发版"), true);
  assert.equal(containsTerm("", "发版"), false);
});

test("matchKnowledge：标签命中、标题长词命中，无关话题不出现", () => {
  const items: RecallKnowledge[] = [
    { id: 43, title: "erp-gva 正式（ims）发版路径", tags: ["erp-gva", "发版", "jenkins"], updatedAt: 2 },
    { id: 40, title: "GrowthOS 配置仓改法", tags: ["growthos", "配置"], updatedAt: 1 },
  ];
  const hit = matchKnowledge("润森盛的 erp-gva 发版怎么走", items);
  assert.deepEqual(hit.map((k) => k.id), [43]);
  assert.deepEqual(matchKnowledge("今天天气不错，出去走走", items), []);
});

test("matchKnowledge：数量有上限，按分数与更新时间排序", () => {
  const items: RecallKnowledge[] = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, title: `发版 第${i}篇`, tags: ["发版"], updatedAt: i,
  }));
  const hit = matchKnowledge("发版", items, 2);
  assert.equal(hit.length, 2);
  assert.deepEqual(hit.map((k) => k.id), [6, 5], "同分时新的在前");
});

test("matchObjects：名称/别名命中，歧义不猜，最多 2 个", () => {
  const items: RecallObject[] = [
    { id: "project:erp-gva", type: "project", name: "erp-gva", aliases: ["ERP"], description: "核心业务系统", relations: 12 },
    { id: "project:growthos", type: "project", name: "GrowthOS", relations: 4 },
    { id: "service:billing", type: "service", name: "billing", aliases: ["计费"], relations: 2 },
  ];
  const r1 = matchObjects("erp-gva 的权限问题", items);
  assert.deepEqual(r1.hits.map((o) => o.id), ["project:erp-gva"]);

  const r2 = matchObjects("顺手看下 billing 和 计费", items);
  assert.deepEqual(r2.hits.map((o) => o.id), ["service:billing"], "名称和别名命中同一对象只算一次");

  const amb: RecallObject[] = [
    { id: "a", type: "project", name: "同名", relations: 0 },
    { id: "b", type: "service", name: "同名", relations: 0 },
  ];
  const r3 = matchObjects("同名的事怎么办", amb);
  assert.deepEqual(r3.hits, []);
  assert.deepEqual(r3.ambiguous.sort(), ["a", "b"]);
});

test("recallBlock：命中知识才注入，无关消息返回空串", () => {
  const s = new Store(":memory:");
  s.addKnowledge({
    title: "erp-gva 正式（ims）发版路径",
    body: "改配置仓 conf/GrowthOS 的 versions.env，推 master，再跑 growthos-deploy-prod。",
    tags: JSON.stringify(["erp-gva", "发版", "jenkins"]),
    now: 1,
  });

  const block = recallBlock(s, [{ from_self: false, text: "erp-gva 怎么发版？", pool_id: "p1" } as any]);
  assert.match(block, /可能与当前对话相关/);
  assert.match(block, /erp-gva 正式/);

  assert.equal(recallBlock(s, [{ from_self: false, text: "中午吃什么", pool_id: "p1" } as any]), "");
  assert.equal(recallBlock(s, [{ from_self: true, text: "erp-gva 发版", pool_id: "p1" } as any]), "", "自己说的话不算提及");
  s.close();
});
