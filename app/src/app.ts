/** 组装：Store + Hub + Scheduler + RunQueue + PlanEngine + Agent 引擎；处理唤醒。 */
import path from "node:path";
import type { Config } from "./config.ts";
import { Store } from "./core/db.ts";
import { Hub } from "./core/hub.ts";
import { Logger } from "./core/logger.ts";
import { PlanEngine } from "./core/plans.ts";
import { RunQueue } from "./core/queue.ts";
import { Scheduler } from "./core/scheduler.ts";
import { realClock, type Clock } from "./core/clock.ts";
import { dayKey } from "./core/time.ts";
import { EmojiTable } from "./core/emoji.ts";
import { needsPlanNudge } from "./core/nudge.ts";
import { toImageContent } from "./core/media.ts";
import type { ImagePart } from "./agent/engine.ts";
import type { Attachment } from "./types.ts";
import { PiEngine, type AgentEngine } from "./agent/engine.ts";
import { createTools } from "./agent/tools.ts";
import { systemPrompt, wakePrompt } from "./agent/prompt.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Plan, StoredMessage, Wake } from "./types.ts";

export interface AppOptions {
  cfg: Config;
  model: Model<any>;
  modelRuntime: ModelRuntime;
  clock?: Clock;
  dbFile?: string;
  logger?: Logger;
  inMemorySessions?: boolean;
}

/** 从消息里挑最近的 N 张图，转成 pi 的 image content；文件读不到就跳过。 */
export function pickImages(msgs: { attachment?: Attachment | null }[], max: number): ImagePart[] {
  const n = Math.max(1, max);
  return msgs.filter((m) => m.attachment).slice(-n)
    .map((m) => toImageContent(m.attachment!))
    .filter((x): x is ImagePart => !!x);
}

export class App {
  readonly store: Store;
  readonly hub: Hub;
  readonly log: Logger;
  readonly queue: RunQueue;
  readonly scheduler: Scheduler;
  readonly plans: PlanEngine;
  readonly engine: AgentEngine;
  readonly emoji: EmojiTable;
  private clock: Clock;
  /** 当前正在处理的唤醒，工具用它判断这轮是不是主动开口 */
  private activeWake: { type: string } | null = null;
  /** 本轮是否决定不回（stay_silent）；每轮唤醒重置 */
  private silenceReason: string | null = null;
  /** 本轮 send 成功次数 */
  private sendsThisTurn = 0;
  /** 每次唤醒结束后的回调（模拟器/测试用） */
  onWakeDone?: (entry: any) => void;

  constructor(private o: AppOptions) {
    const cfg = o.cfg;
    this.clock = o.clock ?? realClock;
    this.log = o.logger ?? new Logger(cfg.logDir);
    this.store = new Store(o.dbFile ?? path.join(cfg.dataDir, "poolchat.db"));
    this.emoji = EmojiTable.load(cfg.emoji.table, cfg.emoji.map);
    this.hub = new Hub(this.store, cfg, this.log, this.emoji);
    this.plans = new PlanEngine(this.store, { missedPolicy: cfg.plans.missedPolicy, missedGraceMs: cfg.plans.missedGraceMs, tz: cfg.timezone, tide: cfg.tide }, this.clock.now());
    this.queue = new RunQueue((w) => this.handleWake(w));
    this.queue.onError = (e) => this.log.error("唤醒处理异常", e);
    this.scheduler = new Scheduler(cfg.scheduler, {
      clock: this.clock, queue: this.queue, isPaused: () => this.store.isPaused(),
      poolsWithUnread: () => this.store.poolsWithUnread(), duePlans: (now) => this.plans.due(now),
      log: (m) => this.log.info(`[sched] ${m}`), warn: (m) => this.log.warn(`[sched] ${m}`),
    });
    this.hub.scheduler = this.scheduler;
    const tools = createTools({
      store: this.store, hub: this.hub, cfg, now: () => this.clock.now(),
      currentWake: () => this.activeWake,
      silenceReason: () => this.silenceReason,
      markSilent: (reason: string) => { this.silenceReason = reason; },
    });
    this.engine = new PiEngine({ cfg, store: this.store, log: this.log, tools, systemPrompt: systemPrompt(cfg, this.emoji.commonIds()), model: o.model, modelRuntime: o.modelRuntime, inMemorySessions: o.inMemorySessions });
  }

  async start() {
    await this.hub.startAdapters();
    this.scheduler.start();
    this.log.info(`poolchat 已启动 tick=${this.o.cfg.scheduler.tickMs}ms debounce=${this.o.cfg.scheduler.debounceMs}ms paused=${this.store.isPaused()}`);
  }

  async stop() {
    this.scheduler.stop();
    await this.queue.idle();
    await this.hub.stopAdapters();
    await this.engine.dispose();
    this.store.close();
  }

  /** 唤醒处理：纯代码决定要不要调用 LLM；真正需要时才调用 pi。 */
  async handleWake(w: Wake): Promise<void> {
    this.activeWake = w;
    this.silenceReason = null;
    this.sendsThisTurn = 0;
    try {
      await this.handleWakeInner(w);
    } finally {
      this.activeWake = null;
    }
  }

  private async handleWakeInner(w: Wake): Promise<void> {
    const cfg = this.o.cfg;
    const t0 = this.clock.now();
    const entry: any = { ts: new Date(t0).toISOString(), type: w.type, reasons: w.reasons, pools: [...w.pools], plans: w.planFires.map((f) => f.planId) };
    const finish = (outcome: string, extra: Record<string, unknown> = {}) => {
      Object.assign(entry, { outcome, ms: this.clock.now() - t0 }, extra);
      this.store.addWakeLog(entry);
      this.log.wake(entry);
      this.log.info(`唤醒 ${w.type} → ${outcome}${extra.sent ? ` 发送${(extra.sent as unknown[]).length}条` : ""}`);
      this.onWakeDone?.(entry);
    };

    if (this.store.isPaused()) return finish("skipped:paused");
    const day = dayKey(t0, cfg.timezone);
    const usage = this.store.getUsage(day);
    if (usage.llm_calls >= cfg.limits.dailyLlmCalls || usage.tokens >= cfg.limits.dailyTokens)
      return finish("skipped:daily-cap", { usage });

    // 读池：所有有未读的池（不只是触发的池），一次唤醒合并处理
    const plans: Plan[] = w.planFires.map((f) => this.store.getPlan(f.planId)).filter((p): p is Plan => !!p);
    const cursorsBefore = new Map(this.store.poolsWithUnread().map((p) => [p, this.store.getCursor(p)]));
    const unread = this.hub.takeUnread();
    if (!unread.length && !plans.length) return finish("skipped:nothing-new");

    const involved = new Set<string>([...unread.map((m) => m.pool_id), ...plans.map((p) => p.pool_id).filter((x): x is string => !!x)]);
    const context = new Map<string, StoredMessage[]>();
    const memories = new Map<string, { user_id: string; items: { id: number; content: string }[] }[]>();
    for (const pid of involved) {
      const pool = this.store.getPool(pid);
      if (!pool) continue;
      if (!this.engine.seenPools.has(pid)) {
        const firstUnread = unread.find((m) => m.pool_id === pid)?.seq ?? Number.MAX_SAFE_INTEGER;
        context.set(pid, this.store.recentMessages(pid, cfg.context.recentContextMessages, firstUnread - 1));
      }
      const users = [...new Set(unread.filter((m) => m.pool_id === pid && m.user_id).map((m) => m.user_id!))];
      const list = [];
      for (const u of users) {
        const key = `${pid}|${u}`;
        if (this.engine.seenPools.has(key)) continue;
        const items = this.store.visibleMemories(u, pool, cfg.context.maxMemoriesPerUser);
        if (items.length) list.push({ user_id: u, items });
        this.engine.seenPools.add(key);
      }
      if (list.length) memories.set(pid, list);
    }
    const handoff = this.engine.takePendingHandoff();
    entry.handoffIncluded = !!handoff;
    const prompt = wakePrompt(this.store, { wake: w, now: t0, unread, context, memories, plans, handoff });
    for (const pid of involved) this.engine.seenPools.add(pid);
    entry.read = unread.map((m) => ({ pool: m.pool_id, seq: m.seq, from: m.sender_name, text: m.text.slice(0, 80) }));
    entry.promptChars = prompt.length;

    // 未读里的图 + 之前被 send 顺带消费掉的图，按 seq 去重后取最近 N 张
    const pending = this.hub.takePendingMedia();
    const mediaMsgs = [...new Map([...unread, ...pending].map((m) => [m.seq, m])).values()]
      .sort((a, b) => a.seq - b.seq);
    const images = pickImages(mediaMsgs, cfg.media.maxImagesInContext);
    entry.imageMsgs = mediaMsgs.filter((m) => m.attachment).length;
    entry.imageCount = images.length;
    if (entry.imageMsgs) this.log.info(`图片：图片消息 ${entry.imageMsgs} 条（未读 ${unread.length} / 待补 ${pending.length}），实际传入 ${entry.imageCount} 张`);
    const fullPrompt = images.length
      ? `${prompt}\n\n【附带图片】本轮有 ${images.length} 张图片随消息一起附上，对应上文出现的 [图片]，按出现顺序排列。`
      : prompt;
    const res = await this.engine.run(fullPrompt, { tokensLeft: cfg.limits.dailyTokens - usage.tokens, callsLeft: cfg.limits.dailyLlmCalls - usage.llm_calls }, images);
    this.store.addUsage(day, res.llmCalls, res.tokens, 1);

    // 主动唤醒兜底：这是它自己排的计划，说完却没给自己排下一次 → 补一次极短的自我决定
    // 只劝它「要么排、要么明确不排」，不替它做决定，也不用 send 再发一条。
    if (needsPlanNudge({ wakeType: w.type, error: res.error, aborted: res.aborted, toolCalls: res.toolCalls })) {
      const left = {
        tokensLeft: cfg.limits.dailyTokens - usage.tokens - res.tokens,
        callsLeft: cfg.limits.dailyLlmCalls - usage.llm_calls - res.llmCalls,
      };
      if (left.callsLeft > 0 && left.tokensLeft > 0) {
        try {
          const r2 = await this.engine.run(
            "你刚才是照自己排的计划开口的，说完了。现在做决定：还想接着聊，就用 plan_add 给自己排下一次（content 写清到点要说什么）；不想，就只回一句「不排」。别用 send，这条不发出去。",
            left,
          );
          this.store.addUsage(day, r2.llmCalls, r2.tokens, 0);
          res.toolCalls.push(...r2.toolCalls);
          res.tokens += r2.tokens;
          res.llmCalls += r2.llmCalls;
          entry.nudged = true;
          this.log.info(`主动唤醒没排下次计划 → 已补提醒（${r2.toolCalls.some((c) => c.name === "plan_add" && !c.isError) ? "排上了" : "它说不排"}）`);
        } catch (e) {
          this.log.warn(`补提醒失败：${(e as Error).message}`);
        }
      }
    }
    const sent = res.toolCalls.filter((c) => c.name === "send" && !c.isError).map((c) => c.args);
    this.sendsThisTurn = sent.length;
    if (this.silenceReason) entry.silent = this.silenceReason;
    entry.sentCount = sent.length;
    // LLM 出错且什么都没发：回滚游标，下次 tick 重试
    if (res.error && !sent.length) for (const [p, seq] of cursorsBefore) this.store.setCursor(p, seq);
    finish(res.error ? "error" : res.aborted ? `aborted:${res.abortReason}` : "ok", {
      tools: res.toolCalls.map((c) => ({ name: c.name, args: c.args, result: c.result, isError: c.isError })),
      sent, assistantText: res.assistantText, llmCalls: res.llmCalls, tokens: res.tokens,
      contextTokens: res.contextTokens, handoffId: res.handoffId, error: res.error,
    });
  }
}
