import { test } from "node:test";
import assert from "node:assert/strict";
import { gapFor, waitBefore, visibleLen, MAX_GAP_MS } from "../src/core/pacing.ts";
import { Hub } from "../src/core/hub.ts";
import { Store } from "../src/core/db.ts";
import { loadConfig } from "../src/config.ts";

const log: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test("间隔跟着上一条的长度走，越长停得越久", () => {
  assert.equal(gapFor(0), 800);
  assert.equal(gapFor(10), 1500);
  assert.equal(gapFor(20), 2000);
  assert.equal(gapFor(50), 3000);
  assert.equal(gapFor(100), MAX_GAP_MS);
});

test("超过一百字也不超过五秒——人打长段的停顿是有上限的", () => {
  assert.equal(gapFor(5000), MAX_GAP_MS);
  assert.ok(gapFor(60) <= MAX_GAP_MS);
});

test("插值是连续的：字数涨一点，间隔不会跳", () => {
  let prev = gapFor(0);
  for (let n = 1; n <= 110; n++) {
    const g = gapFor(n);
    assert.ok(g >= prev, `n=${n} 的间隔 ${g} 小于 n=${n - 1} 的 ${prev}`);
    assert.ok(g - prev <= 80, `n=${n} 跳变 ${g - prev}ms 太大`);
    prev = g;
  }
});

test("从没发过就不等；发过就等剩余时间", () => {
  assert.equal(waitBefore(10, 0, 1_000_000), 0);
  assert.equal(waitBefore(10, 1_000_000, 1_000_000), 1500);   // 刚发完
  assert.equal(waitBefore(10, 1_000_000, 1_000_500), 1000);   // 过了 0.5s
  assert.equal(waitBefore(10, 1_000_000, 1_001_400), 100);    // 快到了
  assert.equal(waitBefore(10, 1_000_000, 1_002_000), 0);      // 已经够了，不补等
});

test("可见字数不数表情标记", () => {
  assert.equal(visibleLen("好[emoji:捂脸]"), 1);
  assert.equal(visibleLen("  好 的  "), 2);
  assert.equal(visibleLen("[emoji:强]"), 0);
});

/** 记录每条消息落地时刻的假适配器 */
function clockAdapter() {
  const hits: { text: string; at: number }[] = [];
  let n = 0;
  return {
    hits,
    adapter: {
      platform: "feishu" as const,
      start: async () => {},
      stop: async () => {},
      sendText: async (_id: string, text: string) => { hits.push({ text, at: Date.now() }); return { msgId: `m${++n}` }; },
    },
  };
}

function hubWith(pacingEnabled: boolean) {
  const cfg = loadConfig();
  cfg.send.confirmWaitMs = 0;
  cfg.send.pacing.enabled = pacingEnabled;
  const store = new Store(":memory:");
  const hub = new Hub(store, cfg, log, {} as any);
  const { adapter, hits } = clockAdapter();
  hub.addAdapter(adapter as any);
  // 造一个池
  store.insertMessage({
    platform: "feishu", external_chat_id: "oc_pace", pool_kind: "private", msg_id: "u1",
    sender_id: "u1", sender_name: "他", ts: Date.now(), text: "在吗",
    reply_to: null, mentions: [], is_mention_me: false, media_type: "text",
  });
  // 唤醒时未读已经被抽走了：这里补上，否则第一次 send 会被「压住」判定拦下
  hub.takeUnread();
  return { hub, store, hits };
}

test("接线层：三条连发被拉开，第一条不排队", async () => {
  const { hub, hits } = hubWith(true);
  const t0 = Date.now();
  await hub.send("feishu:oc_pace", "嗯");
  const firstAt = hits[0].at - t0;
  await hub.send("feishu:oc_pace", "钥匙弄了吗");
  await hub.send("feishu:oc_pace", "我这边也刚醒");
  const total = hits[hits.length - 1].at - hits[0].at;
  assert.equal(hits.length, 3);
  assert.ok(firstAt < 400, `第一条不该等，实际等了 ${firstAt}ms`);
  // 两条间隔下限：1 字 → 800ms；6 字 → 约 1220ms
  assert.ok(total >= 1900, `三条之间应该有接近 2 秒的间隔，实际 ${total}ms`);
});

test("关掉 pacing 就回到连发（不额外加延迟）", async () => {
  const { hub, hits } = hubWith(false);
  await hub.send("feishu:oc_pace", "嗯");
  await hub.send("feishu:oc_pace", "钥匙弄了吗");
  const total = hits[hits.length - 1].at - hits[0].at;
  assert.ok(total < 300, `关掉后不该有间隔，实际 ${total}ms`);
});

test("系统提示不走节奏：额度提示立刻发", async () => {
  const { hub, hits } = hubWith(true);
  await hub.send("feishu:oc_pace", "很长很长很长的一句话，长到下一句要等三秒才发得出去");
  const t0 = Date.now();
  await hub.send("feishu:oc_pace", "〔系统〕今天的额度用完了", { internal: true });
  assert.ok(hits[hits.length - 1].at - t0 < 300, "系统提示不该被她的节奏拖着");
});
