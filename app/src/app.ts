/** 组装：Store + Hub + Scheduler + RunQueue + PlanEngine + Agent 引擎；处理唤醒。 */
import path from "node:path";
import type { Config } from "./config.ts";
import { Store } from "./core/db.ts";
import { Hub } from "./core/hub.ts";
import { Logger } from "./core/logger.ts";
import { PlanEngine } from "./core/plans.ts";
import { waveCandidate, inQuietHours, waveCfg as cfgApp } from "./core/wave.ts";
import { energyCfg, replay, verdict, settle, type EnergyConfig } from "./core/energy.ts";
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
    this.store = new Store(o.dbFile ?? path.join(cfg.dataDir, "rabbit-bot.db"));
    this.emoji = EmojiTable.load(cfg.emoji.table, cfg.emoji.map);
    this.hub = new Hub(this.store, cfg, this.log, this.emoji);
    this.plans = new PlanEngine(this.store, { missedPolicy: cfg.plans.missedPolicy, missedGraceMs: cfg.plans.missedGraceMs, tz: cfg.timezone, tide: cfg.tide }, this.clock.now());
    this.queue = new RunQueue((w) => this.handleWake(w));
    this.queue.onError = (e) => this.log.error("唤醒处理异常", e);
    this.scheduler = new Scheduler(cfg.scheduler, {
      clock: this.clock, queue: this.queue, isPaused: () => this.store.isPaused(),
      poolsWithUnread: () => this.store.poolsWithUnread(), duePlans: (now) => this.plans.due(now),
      proactivePools: (now) => this.proactivePools(now),
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
    this.log.info(`rabbit-bot 已启动 tick=${this.o.cfg.scheduler.tickMs}ms debounce=${this.o.cfg.scheduler.debounceMs}ms 消息tick批=${this.o.cfg.scheduler.batchToTick ? "on" : "off"} 缓存折算=${this.o.cfg.limits.cacheReadRate} 换会话=${this.o.cfg.handoff.sessionTokenLimit}tok 日额度=${this.o.cfg.limits.dailyTokens}tok paused=${this.store.isPaused()}`);
  }

  async stop() {
    this.scheduler.stop();
    await this.queue.idle();
    await this.hub.stopAdapters();
    await this.engine.dispose();
    this.store.close();
  }

  /**
   * 每个 tick 问一次：哪些池的水位退到了新的一档。
   * 这里不决定说不说，只决定「给她一次机会」——说什么、发不发交给 agent。
   */
  private proactivePools(now: number): NonNullable<Wake["proactive"]> {
    const cfg = this.o.cfg.tide?.wave;
    const ecfg = energyCfg(this.o.cfg.tide?.energy);
    if (!cfg?.enabled && !ecfg.enabled) return [];
    // 记账先做：静默期、额度用完都不该让电量停摆
    if (ecfg.enabled) {
      for (const p of this.store.listPools()) this.energyAccrue(p.pool_id, now, ecfg);
    }
    // 夜间不叫：叫醒只是为了让她说句话，凌晨说给谁听
    if (inQuietHours(now, cfgApp(cfg), this.o.cfg.timezone)) return [];
    // 每天的次数和 token 都封顶：一个人一天被想起 8 次够了，凌晨连问 60 次那是程序发疯
    const dayStart = now - ((now + 8 * 3600e3) % 86400e3);
    const used = this.store.proactiveUsage(dayStart, dayStart + 86400e3);
    if (used.wakes >= cfgApp(cfg).maxWakesPerDay) return [];
    if (used.tokens >= cfgApp(cfg).dailyTokens) return [];
    const out: NonNullable<Wake["proactive"]> = [];
    for (const pool of this.store.listPools()) {
      if (ecfg.enabled) {
        const e = this.energyTick(pool.pool_id, now, ecfg);
        if (e) out.push(e);
        continue;
      }
      const c = waveCandidate(this.store, pool.pool_id, now, cfg);
      if (!c?.ok) continue;
      // 沉默也要有重量：连着两次放行都没开口，这次就把话说重一点
      const silent = this.store.silentWaveStreak(pool.pool_id);
      const detail = silent >= 2 ? `${c.detail}｜已经连着 ${silent} 次放行都没开口，这次除非真的没话说，别再憋着` : c.detail;
      out.push({ pool: pool.pool_id, stage: c.stage, a: c.a, peak: c.peak, sessionTs: c.sessionTs, detail });
    }
    return out;
  }

  /**
   * 记账：把 ts→now 之间的消息记到电量上，写回 kv。
   *
   * 这一步必须**先于**额度/静默期检查执行——电量是关系状态，不是「今天还能不能唤醒」的开关。
   * 放在额度后面的话，额度用完的那天她整天不记账，第二天结算时发现「昨天一片空白」。
   */
  private energyAccrue(poolId: string | null, now: number, ecfg: EnergyConfig): number {
    if (!poolId) return ecfg.floor;
    const key = `energy.${poolId}`;
    const dayStart = now - ((now + 8 * 3600e3) % 86400e3);
    const day = new Date(dayStart).toISOString().slice(0, 10);

    let st: { E: number; ts: number; day: string };
    try {
      const raw = JSON.parse(this.store.getKv(key) ?? "");
      if (typeof raw?.E !== "number" || typeof raw?.ts !== "number") throw new Error("bad");
      st = raw;
    } catch {
      const base = this.settleDay(poolId, dayStart - 86400e3, dayStart, ecfg);
      st = { E: base, ts: dayStart, day };
    }

    if (st.day !== day) {
      st = { E: this.settleDay(poolId, dayStart - 86400e3, dayStart, ecfg), ts: dayStart, day };
    }

    // 只处理已发生的那部分；now 本身留给下一 tick，避免相邻 tick 把同一条消息充两次
    const rows = this.store.messagesForWave(poolId, st.ts, now);
    const rep = replay(st.E, rows.map((r) => ({ ts: r.ts, fromSelf: !!r.from_self })), st.ts, now, ecfg);
    this.store.setKv(key, JSON.stringify({ E: rep.E, ts: now, day }));
    return rep.E;
  }

  /**
   * 充能模型的每个 tick：先把这段消息记到电量上，再问「现在能不能开口」。
   *
   * 状态存在 kv（`energy.<pool>`），字段 `{ E, ts, day }`。`ts` 是上次结算到的时刻，
   * 每次只处理 ts→now 之间的消息——同一条红蓝区间因此不会被充两次。
   */
  private energyTick(
    poolId: string | null, now: number, ecfg: EnergyConfig,
  ): NonNullable<Wake["proactive"]>[number] | null {
    if (!poolId) return null;
    const E = this.energyAccrue(poolId, now, ecfg);
    const rep = { E };
    // 基准是「距她最后说话多久」，不是「距任何人说话」。
    // 她答完你 5 分钟没接，她就可以自己补一句/换个话题——这才叫主动，而不是单纯回答。
    // 不乘三倍：三倍是防「她主动开口后没人理还追问」，她用回答收尾时不该受这个惩罚。
    const mine = this.store.lastSelfMessage(poolId);
    if (!mine) return null;
    const v = verdict(rep.E, mine.ts, false, now, ecfg);
    if (!v.ok) return null;

    const silent = this.store.silentWaveStreak(poolId);
    const detail = silent >= 2
      ? `${v.detail}｜已经连着 ${silent} 次放行都没开口，这次除非真的没话说，别再憋着`
      : v.detail;
    return {
      pool: poolId,
      stage: Math.max(1, Math.round(ecfg.cap - rep.E)),
      a: rep.E,
      peak: ecfg.cap,
      sessionTs: mine.ts,
      detail,
    };
  }

  /** 隔夜结算：昨天她发出的每条消息 → 他多久才回，折算成今天的基准电量 */
  private settleDay(poolId: string | null, from: number, to: number, ecfg: EnergyConfig): number {
    const rows = this.store.messagesForWave(poolId, from, to);
    const replies: number[] = [];
    let pending: number | null = null;
    for (const r of rows) {
      if (r.from_self) {
        if (pending === null) pending = r.ts;   // 连发几条算同一次开口
      } else if (pending !== null) {
        replies.push((r.ts - pending) / 60e3);
        pending = null;
      }
    }
    return settle(replies, ecfg);
  }

  /**
   * 额度用完时，给还在等回复的人发一条提示。
   *
   * 三个约束：不走模型（零成本）、不进上下文（hub.send 直接发，不写库）、每天最多一次。
   * 只在「有人正等着」的时候发——没人说话时耗尽额度，静悄悄待着就好，不用通知。
   */
  private async notifyCap(day: string): Promise<string | null> {
    const n = this.o.cfg.limits.capNotice;
    if (!n?.enabled) return null;
    const key = `capNotice.${day}`;
    if (n.oncePerDay && this.store.getKv(key)) return null;
    const waiting = this.store.poolsWithUnread();
    if (!waiting.length) return null;
    const sent: string[] = [];
    for (const pool of waiting) {
      try {
        const r = await this.hub.send(pool, n.text, { internal: true });
        if (r.ok) sent.push(pool);
      } catch (e) {
        this.log.warn(`额度提示发送失败 ${pool}：${(e as Error).message}`);
      }
    }
    if (!sent.length) return null;
    this.store.setKv(key, String(this.clock.now()));
    this.log.info(`额度用尽，已发提示到 ${sent.length} 个池（不进上下文）：${n.text}`);
    return n.text;
  }

  /**
   * 程序自己出的错，直接发到 IM：不走模型、不进上下文。
   *
   * 和 capNotice 的区别：那条是「额度用完了」这种预期内的暂停，这条是「出故障了」。
   * 用户看到的都是「她没回我」——但前者是设计，后者是 bug，得让人知道是哪种，
   * 否则他只会觉得被无视，然后一直等。
   *
   * 只发给「有未读在等」的池：没人等着的时候报错，静悄悄修就是了，不必打扰。
   * 同一个 kind 在 dedupeMinutes 内只发一次——报错往往连续触发，不能刷屏。
   */
  private async notifySys(kind: string, text: string): Promise<void> {
    const n = this.o.cfg.limits.errorNotice;
    if (!n?.enabled) return;
    const waiting = this.store.poolsWithUnread();
    if (!waiting.length) return;
    const key = `sysNotice.${kind}`;
    const now = this.clock.now();
    const last = Number(this.store.getKv(key) ?? 0);
    if (now - last < (n.dedupeMinutes ?? 60) * 60_000) return;
    const sent: string[] = [];
    for (const pool of waiting) {
      try {
        const r = await this.hub.send(pool, text, { internal: true });
        if (r.ok) sent.push(pool);
      } catch (e) {
        this.log.warn(`系统消息发送失败 ${pool}：${(e as Error).message}`);
      }
    }
    if (!sent.length) return;
    this.store.setKv(key, String(now));
    this.log.info(`系统消息（${kind}）→ ${sent.length} 个池（不进上下文）：${text}`);
  }

  /** 把 {reason} 填进配置文案里；错误信息太长就截断，别把整段堆栈发给人 */
  private errorText(reason: string): string {
    const text = this.o.cfg.limits.errorNotice?.text ?? "〔系统〕我这边出了点问题（{reason}）。";
    return text.replace("{reason}", (reason || "未知原因").split("\n")[0].slice(0, 120));
  }

  /** 唤醒处理：纯代码决定要不要调用 LLM；真正需要时才调用 pi。 */
  async handleWake(w: Wake): Promise<void> {
    this.activeWake = w;
    this.silenceReason = null;
    this.sendsThisTurn = 0;
    try {
      await this.handleWakeInner(w);
    } catch (e) {
      // 真崩了（模板缺变量、适配器炸了、意料之外的 throw）：用户那边只看到「她不回我」
      this.log.error(`唤醒异常：${(e as Error).stack ?? e}`);
      await this.notifySys("crash", this.errorText((e as Error).message)).catch(() => {});
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
    if (usage.llm_calls >= cfg.limits.dailyLlmCalls || usage.tokens >= cfg.limits.dailyTokens) {
      const notice = await this.notifyCap(day);
      return finish("skipped:daily-cap", notice ? { usage, notice } : { usage });
    }

    // 读池：所有有未读的池（不只是触发的池），一次唤醒合并处理
    const plans: Plan[] = w.planFires.map((f) => this.store.getPlan(f.planId)).filter((p): p is Plan => !!p);
    const cursorsBefore = new Map(this.store.poolsWithUnread().map((p) => [p, this.store.getCursor(p)]));
    const unread = this.hub.takeUnread();
    const proactive = w.proactive ?? [];
    if (!unread.length && !plans.length && !proactive.length) return finish("skipped:nothing-new");

    const involved = new Set<string>([
      ...unread.map((m) => m.pool_id),
      ...plans.map((p) => p.pool_id).filter((x): x is string => !!x),
      ...proactive.map((x) => x.pool).filter((x): x is string => !!x),
    ]);
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
    // 谈资只在「没人在跟你说话、她自己得找话说」的时候给：
    // 有人刚开口时她该接那句话，不需要别人替她想话题
    const topicPool = unread[0]?.pool_id ?? [...context.keys()][0] ?? [...w.pools][0] ?? null;
    const topics = w.type === "tick" ? this.store.pickTopics(topicPool, 3, t0) : [];
    const prompt = wakePrompt(this.store, { wake: w, now: t0, unread, context, memories, plans, handoff, topics });
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
    // 这个 session 已经聊掉多少 token：到顶就换个新会话接着聊，
    // 不然上下文越滚越大，每轮都按最贵的那档重发一遍。
    const sessionLimit = cfg.handoff.sessionTokenLimit ?? 0;
    const sessionTokens = sessionLimit > 0 ? this.store.tokensSince(this.store.lastHandoffAt()) : 0;
    const forceHandoff = sessionLimit > 0 && sessionTokens >= sessionLimit;
    if (forceHandoff) entry.sessionTokens = sessionTokens;
    const res = await this.engine.run(fullPrompt, {
      tokensLeft: cfg.limits.dailyTokens - usage.tokens,
      callsLeft: cfg.limits.dailyLlmCalls - usage.llm_calls,
      forceHandoff,
    }, images);
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
    // 问过就算：这一档机会用掉了，不管她说没说。
    // 之前只在发送后记账，导致不打发就一直重问——凌晨每 3 分钟叫一次，6 小时烧掉 200 万 token。
    if (proactive.length) {
      for (const p of proactive) {
        this.store.recordTideEvent({
          pool_id: p.pool, day, ts: this.clock.now(), kind: "wave", anchor_kind: "L2",
          wave_a: p.a, stage: p.stage,
          reason: sent.length ? p.detail : `${p.detail}｜没发（${this.silenceReason ?? "no reason"}）`,
        });
      }
    }
    if (this.silenceReason) entry.silent = this.silenceReason;
    entry.sentCount = sent.length;
    // LLM 出错且什么都没发：回滚游标，下次 tick 重试
    if (res.error && !sent.length) {
      for (const [p, seq] of cursorsBefore) this.store.setCursor(p, seq);
      // 模型/接口报错也是「程序的事」，别让她背锅
      await this.notifySys("error", this.errorText(res.error));
    }
    finish(res.error ? "error" : res.aborted ? `aborted:${res.abortReason}` : "ok", {
      tools: res.toolCalls.map((c) => ({ name: c.name, args: c.args, result: c.result, isError: c.isError })),
      sent, assistantText: res.assistantText, llmCalls: res.llmCalls, tokens: res.tokens,
      // 折算前的原始 token 和 pi 报的美元成本：用来判断缓存到底命中没有
      rawTokens: res.rawTokens, cost: res.cost ? Number(res.cost.toFixed(6)) : undefined,
      contextTokens: res.contextTokens, handoffId: res.handoffId, error: res.error,
    });
  }
}
