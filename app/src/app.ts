/** 组装：Store + Hub + Scheduler + RunQueue + PlanEngine + Agent 引擎；处理唤醒。 */
import path from "node:path";
import type { Config } from "./config.ts";
import { Store } from "./core/db.ts";
import { Hub } from "./core/hub.ts";
import { Logger } from "./core/logger.ts";
import { PlanEngine } from "./core/plans.ts";
import { evaluateGate } from "./core/gate.ts";
import { buildReflectionPrompt, parseReflection } from "./core/reflection.ts";
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
import { createTools, type RbExec } from "./agent/tools.ts";
import { systemPrompt, wakePrompt } from "./agent/prompt.ts";
import { resolveAliases } from "./ops/memories.ts";
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
  /** 测试注入：进程内 rb 执行器（替代容器） */
  rbExec?: RbExec;
}

/**
 * 本地自然日边界（按配置时区）。原来用 `now - ((now + 8h) % 24h)` 硬编码 +8，
 * 时区一改就错；这里改成走 Intl，跟 dayKey 同一口径。
 */
export function dayStartOf(now: number, tz = "Asia/Shanghai"): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const secOfDay = get("hour") * 3600 + get("minute") * 60 + get("second");
  return now - secOfDay * 1000 - (now % 1000);
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
      rbExec: o.rbExec,
    });
    this.engine = new PiEngine({ cfg, store: this.store, log: this.log, tools, systemPrompt: systemPrompt(cfg, this.emoji.commonIds()), model: o.model, modelRuntime: o.modelRuntime, inMemorySessions: o.inMemorySessions });
  }

  async start() {
    await this.hub.startAdapters();
    this.scheduler.start();
    this.startReflectionLoop();
    this.log.info(`rabbit-bot 已启动 tick=${this.o.cfg.scheduler.tickMs}ms debounce=${this.o.cfg.scheduler.debounceMs}ms 消息tick批=${this.o.cfg.scheduler.batchToTick ? "on" : "off"} 缓存折算=${this.o.cfg.limits.cacheReadRate} 换会话=${this.o.cfg.handoff.sessionTokenLimit}tok 日额度=${this.o.cfg.limits.dailyTokens}tok paused=${this.store.isPaused()}`);
  }

  async stop() {
    this.scheduler.stop();
    if (this.reflectionTimer) { clearInterval(this.reflectionTimer as any); this.reflectionTimer = null; }
    await this.queue.idle();
    await this.hub.stopAdapters();
    await this.engine.dispose();
    this.store.close();
  }

  /**
   * 每个 tick 问一次：哪个池该主动开口。
   *
   * 这里不再掷骰子。「想不想说」由自省（core/reflection.ts）给，
   * 这里只跑门控（core/gate.ts）——一道不过就闭嘴，并把理由记进 proactive_log。
   * 以前只在「说了」的时候记账，所以线上永远查不出「她今天为什么一天没说话」。
   */
  private proactivePools(now: number): NonNullable<Wake["proactive"]> {
    const cfg = this.o.cfg;
    if (!cfg.proactive?.enabled) return [];
    const dayStart = dayStartOf(now, cfg.timezone);
    const dayEnd = dayStart + 86400e3;
    // 沉默时长跨池算：切到别的池不代表用户消失了
    const globalLast = this.store.lastUserMessageTs(null);
    const out: NonNullable<Wake["proactive"]> = [];

    for (const pool of this.store.listPools()) {
      const pid = pool.pool_id;
      const r = this.store.latestReflection(pid);
      const urgency = r ? Number(r.urgency) : null;
      const lastSpeak = this.store.lastProactiveSpeakTs(pid);
      // 连说没人回：用户最后一条之后，她主动说了几次。不用存计数器，从库里数出来
      const consecutive = globalLast > 0
        ? this.store.countProactiveSpeaks(globalLast, now + 1, pid)
        : 0;

      const v = evaluateGate({
        now,
        urgency,
        lastUserTs: globalLast,
        poolLastUserTs: this.store.lastUserMessageTs(pid),
        lastSpeakTs: lastSpeak,
        speaksToday: this.store.countProactiveSpeaks(dayStart, dayEnd, pid),
        consecutiveSpeaks: consecutive,
        chatStreaming: this.queue.isBusy(),
        tz: cfg.timezone,
        cfg: cfg.proactive,
      });

      // 只在「被拦下」时记账：真开口的要等这一轮结束才知道发没发出去（她可能决定不说）
      if (!v.speak) {
        this.logProactiveThrottled({
          user_id: this.store.lastUserId(pid), pool_id: pid, ts: now,
          decision: "skip", reason: v.reason,
          urgency, silent_sec: Number.isFinite(v.silentMs) ? Math.round(v.silentMs / 1000) : null,
          cooldown_req: Number.isFinite(v.cooldownRequiredMs) ? Math.round(v.cooldownRequiredMs) : null,
        });
        continue;
      }
      const parts = [
        `想说的程度 ${(urgency ?? 0).toFixed(2)}`,
        r?.thought ? `你刚才在想：${r.thought}` : "",
        r?.style_hint ? `语气：${r.style_hint}` : "",
        r?.topic_pick ? `想聊：${r.topic_pick}${r.topic_angle ? `（${r.topic_angle}）` : ""}` : "",
        `距对方最后说话 ${Math.round(v.silentMs / 60e3)} 分钟`,
      ].filter(Boolean);
      out.push({
        pool: pid, stage: 1, a: urgency ?? 0, peak: 1, sessionTs: now, detail: parts.join("｜"),
      });
    }
    return out;
  }

  /**
   * skip 的记账要节流：tick 三分钟一次，不节流一天能写五百行。
   * 规则：说了一律记；没说只在「理由变了」或「距上次超过 30 分钟」时记——
   * 这样「她为什么一整天没说话」仍然查得到，只是不会刷满库。
   */
  private logProactiveThrottled(e: Parameters<Store["logProactive"]>[0]): void {
    if (e.decision === "speak") { this.store.logProactive(e); return; }
    const last = this.store.lastProactiveLog(e.pool_id);
    if (last && last.reason === e.reason && e.ts - last.ts < 30 * 60e3) return;
    this.store.logProactive(e);
  }

  // ---------- 自省 ----------

  private reflectionTimer: unknown = null;
  private reflectionBusy = false;

  /**
   * 自省循环：独立于 tick 单独跑。
   *
   * 为什么不等 tick：tick 是同步的（要立刻返回候选），自省要调模型。
   * 所以自省在后台把结果写进 reflections 表，tick 只读表。
   */
  private startReflectionLoop(): void {
    const cfg = this.o.cfg;
    if (!cfg.proactive?.enabled) return;
    const every = Math.max(30_000, Math.min(cfg.scheduler.tickMs, 120_000));
    const t = setInterval(() => { void this.reflectDue(); }, every);
    (t as any).unref?.();
    this.reflectionTimer = t;
  }

  /** 挑一个「该想一想了」的池，跑一次自省。一次只做一个，省额度也避免打堆 */
  private async reflectDue(): Promise<void> {
    if (this.reflectionBusy || this.store.isPaused()) return;
    const cfg = this.o.cfg;
    const now = this.clock.now();
    const delay = cfg.proactive?.reflectionDelayMs ?? 300_000;
    for (const pool of this.store.listPools()) {
      const pid = pool.pool_id;
      const lastUser = this.store.lastUserMessageTs(pid);
      // 刚说完话不急着想到底想说什么——先让对话自然停一停
      if (!lastUser || now - lastUser < delay) continue;
      const prev = this.store.latestReflection(pid);
      const nextAt = Number(prev?.next_at ?? 0);
      if (nextAt > now) continue;
      this.reflectionBusy = true;
      try {
        await this.runReflection(pid, now);
      } catch (e) {
        this.log.warn(`自省失败（${pid}）：${(e as Error).message}`);
      } finally {
        this.reflectionBusy = false;
      }
      return;
    }
  }

  private async runReflection(poolId: string, now: number): Promise<void> {
    const cfg = this.o.cfg;
    const day = dayKey(now, cfg.timezone);
    const usage = this.store.getUsage(day);
    const tokensLeft = cfg.limits.dailyTokens - usage.tokens;
    // 自省是「想一想」，不是干活。额度见底就别想了，把额度留给真正的对话
    if (tokensLeft < 2000 || usage.llm_calls >= cfg.limits.dailyLlmCalls) return;

    // 按时间跨度取，不是死数 10 条：话密的时候 10 条只够二十分钟，
    // 他早先说过的事实落在窗口外，她自己刚说错的话却在窗口里，越滚越像真的
    const rows = this.store.messagesForReflection(poolId, 12, { sinceMs: now - 90 * 60e3, cap: 40 });
    const nameOf = (r: { from_self: number }) => (r.from_self ? cfg.agent.name : "对方");
    const recentLines = rows.map((r) => {
      const t = new Intl.DateTimeFormat("zh-CN", {
        timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(r.ts));
      return `[${t}] ${nameOf(r)}：${r.text.slice(0, 200)}`;
    });

    const prev = this.store.latestReflection(poolId);
    const lastSpeak = this.store.lastProactiveSpeakTs(poolId);
    const lastUser = this.store.lastUserMessageTs(null);
    // 上次主动说的原话：自省要知道「我上次说了什么、他回没回」，
    // 不然她会每次都从零开始想，说出来的话也会重复
    const lastSelf = lastSpeak > 0 ? this.store.lastSelfMessage(poolId) : null;
    const prompt = buildReflectionPrompt({
      now,
      tz: cfg.timezone,
      agentName: cfg.agent.name,
      recentLines,
      silentMinutes: (now - this.store.lastUserMessageTs(poolId)) / 60e3,
      lastProactive: lastSpeak > 0
        ? { text: String(lastSelf?.text ?? ""), replied: lastUser > lastSpeak }
        : null,
      prevThought: prev?.thought ? String(prev.thought) : null,
      consecutiveSpeaks: lastUser > 0 ? this.store.countProactiveSpeaks(lastUser, now + 1, poolId) : 0,
    });

    const res = await this.engine.reflect(
      prompt,
      { tokensLeft, callsLeft: cfg.limits.dailyLlmCalls - usage.llm_calls },
      `你正在独处。只做一件事：想清楚此刻心里在想什么、有多想开口。只输出 JSON，不要任何别的内容。`,
    );
    this.store.addUsage(day, res.llmCalls, res.tokens, 0);

    const parsed = parseReflection(res.assistantText ?? "");
    if (!parsed.ok) {
      this.log.warn(`自省输出解析失败（${poolId}）：${parsed.error}｜原文 ${String(res.assistantText ?? "").slice(0, 120)}`);
      this.store.logProactive({
        user_id: this.store.lastUserId(poolId), pool_id: poolId, ts: now,
        decision: "skip", reason: `reflection_parse_error:${parsed.error}`,
      });
      // 解析失败也要排下一次，否则会每个 tick 重试一次，白烧钱
      this.store.saveReflection({
        user_id: this.store.lastUserId(poolId), pool_id: poolId,
        thought: "", style_hint: "", urgency: 0, topic_pick: "", topic_angle: "",
        next_at: now + 15 * 60e3, created_at: now,
      });
      return;
    }

    const value = parsed.value;
    const nextAt = now + (value.nextReflectionInSec ?? 1800) * 1000;
    this.store.saveReflection({
      user_id: this.store.lastUserId(poolId), pool_id: poolId,
      thought: value.thought, style_hint: value.styleHint, urgency: value.urgency,
      topic_pick: value.topicPick, topic_angle: value.topicAngle,
      next_at: nextAt, created_at: now,
    });
    // 自省只留 7 天：它不是档案，是「刚才想了什么」
    this.store.pruneReflections(now - 7 * 86400e3);
    this.log.info(`自省 ${poolId} urgency=${value.urgency.toFixed(2)} 下次=${new Date(nextAt).toISOString()} thought=${value.thought.slice(0, 60)}`);
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
    // 检索前置：他这次的话里出现「那个项目」这类说法时，先把指向翻出来给她，
    // 省掉一轮「您说的是哪个」——那是把记忆的活推回给用户
    const aliases: NonNullable<Parameters<typeof wakePrompt>[1]["aliases"]> = [];
    for (const pid of involved) {
      const pool = this.store.getPool(pid);
      if (!pool) continue;
      const users = [...new Set(unread.filter((m) => m.pool_id === pid && m.user_id).map((m) => m.user_id!))];
      for (const u of users) {
        const said = unread.filter((m) => m.pool_id === pid && m.user_id === u).map((m) => m.text).join("\n");
        const hits = resolveAliases(this.store, { user: u, pool: pid, text: said });
        if (hits.length) aliases.push({ pool: pid, user_id: u, hits });
      }
    }
    const handoff = this.engine.takePendingHandoff();
    entry.handoffIncluded = !!handoff;
    // 话题库已经搬进沙盒（/work/topics），她自己去读，这里不再查库。
    const prompt = wakePrompt(this.store, { wake: w, now: t0, unread, context, memories, aliases, plans, handoff, topics: [] });
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
    // 主动这一轮的真实结果：发了才记 speak（连说计数和冷却都靠这张表），
    // 她决定不说也记一行，理由是 agent_silent——这跟「被门控拦下」是两件事，别混
    if (proactive.length) {
      for (const p of proactive) {
        this.store.logProactive({
          user_id: this.store.lastUserId(p.pool ?? ""), pool_id: p.pool ?? "", ts: this.clock.now(),
          decision: sent.length ? "speak" : "skip",
          reason: sent.length ? "ok" : `agent_silent:${this.silenceReason ?? "no-reason"}`,
          urgency: p.a,
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
