/** 组装：Store + Hub + Scheduler + RunQueue + Agent 引擎；处理唤醒。 */
import path from "node:path";
import fs from "node:fs";
import type { Config } from "./config.ts";
import { isChatCall } from "./core/tool-call.ts";
import { Store } from "./core/db.ts";
import { extractJsonObject } from "./core/json.ts";
import { Hub } from "./core/hub.ts";
import { Logger } from "./core/logger.ts";
import { RunQueue, makeWake } from "./core/queue.ts";
import {
  appendNote, archiveSettledTaskPools, getTask, listTasks, listTasksUpdatedSince, takePendingTick, markPendingTick,
  taskDisplayName, updateTask, type Task,
} from "./core/tasks.ts";
import { sweepExpirations } from "./core/approvals.ts";
import { setTaskEventNotifier } from "./core/task-events.ts";
import { runnerAlive, startTask, sweepDeadRunners, sweepLongRunningTasks, writeTaskDoc, type DispatchDeps } from "./core/dispatch.ts";
import { resolveApiToken } from "./api-token.ts";
import { Scheduler } from "./core/scheduler.ts";
import { AgentWatchdog, type WatchdogDecision } from "./core/agent-watchdog.ts";
import { appendScheduleEvent, ensureSchedulePool, fireSchedule } from "./core/schedules.ts";
import { realClock, type Clock } from "./core/clock.ts";
import { dayKey, fmtShort } from "./core/time.ts";
import { costUsd } from "./core/pricing.ts";
import { EmojiTable } from "./core/emoji.ts";
import { mediaId, toImageContent } from "./core/media.ts";
import type { ImagePart } from "./agent/engine.ts";
import type { Attachment } from "./types.ts";
import { PiEngine, resolveModel, type AgentEngine, type RunResult } from "./agent/engine.ts";
import { effectiveModelSettings, saveModelSettings, type ModelSettings } from "./ops/model-settings.ts";
import { createTools, type RbExec } from "./agent/tools.ts";
import { ApprovalGate } from "./core/approval.ts";
import { TaskApprovalGate, formatTaskApprovalText, taskApprovalTimeoutMs, type TaskApprovalOutcome, type TaskApprovalTarget } from "./core/task-approval.ts";
import { SendReviewGate, resolveSendReviewConfig } from "./core/send-review.ts";
import { effectiveSendReviewSettings, mainPoolId, reviewRequiredFor } from "./ops/send-review-settings.ts";
import { systemPrompt, wakePrompt } from "./agent/prompt.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { StoredMessage, Wake } from "./types.ts";
import { resolvePrimaryPool } from "./core/primary-pool.ts";
import { businessDir, ensureSharedWorkspace, runtimeDir, sharedDir } from "./core/runtime.ts";
import { ensureWorkingMemory } from "./core/working-memory.ts";
import { ensureBusinessSeeded } from "./ops/business-map.ts";
import { render } from "./agent/template.ts";
import {
  effectiveMemoryReviewSettings, loadMemoryReviewState, memoryReviewDue, saveMemoryReviewState,
  type MemoryReviewState,
} from "./ops/memory-review.ts";
import { effectiveWatchdogSettings } from "./ops/watchdog-settings.ts";
import { effectiveWebChat } from "./core/web-auth.ts";

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
  /** 测试注入：替换任务执行器可执行文件（审批通过后启动任务用） */
  executorBin?: string;
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

/** 任务审批的几种收口：通过、驳回、超时、取消（Web/IM 共用）。 */
export type TaskDecision = "approved" | "rejected" | "timeout" | "cancelled";

export interface PickedImage { seq: number; id: string; image: ImagePart }

/**
 * 从消息里挑最近的 N 张图，并带回每张图的 id 和消息 seq。
 * id 会写进消息文本（[图片#img_xxx]），提示词里按同样顺序列出来，
 * 模型才能分清「哪张图对应哪条消息」，而不是只盯着最后一张。
 */
export function pickImageEntries(
  msgs: { seq?: number; msg_id?: string; media_type?: string; attachment?: Attachment | null }[],
  max: number,
): PickedImage[] {
  const n = Math.max(1, max);
  return msgs
    .filter((m) => m.media_type === "image" && m.attachment?.path)
    .slice(-n)
    .map((m) => {
      const image = toImageContent(m.attachment!);
      if (!image) return null;
      const seq = m.seq ?? 0;
      // 老数据没有 attachment.id：文件名就是 id（img_xxx.jpg），从 path 反推；认不出才退回 hash
      const fromPath = m.attachment!.path ? path.basename(m.attachment!.path).replace(/\.[^.]+$/, "") : "";
      const id = m.attachment!.id ?? (/^img_[\w-]+$/.test(fromPath) ? fromPath : mediaId("img", `${m.msg_id ?? ""}:${seq}`));
      return { seq, id, image };
    })
    .filter((x): x is PickedImage => !!x);
}

/** 兼容旧调用：只取图片内容。 */
export function pickImages(msgs: Parameters<typeof pickImageEntries>[0], max: number): ImagePart[] {
  return pickImageEntries(msgs, max).map((x) => x.image);
}

/** 任务汇报的游标：只转述这条线之后的终态任务，重启后也不会重发。 */
const TASK_RELAY_CURSOR_KEY = "ufa.task_relay_cursor";
/** 上次真正转述的时刻：两次转述之间至少隔 5 分钟，任务再多也只攒成一批。 */
const TASK_RELAY_LAST_KEY = "ufa.task_relay_last_at";
const TASK_RELAY_COOLDOWN_MS = 5 * 60_000;
/** 一次 digest 每个池最多逐条列这么多，其余只报数量。 */
const TASK_RELAY_MAX_LISTED = 10;
const TASK_RELAY_REPORT_CHARS = 1200;

function clipText(s: string, n: number): string {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 读 worker 落在 runtime/shared/handoffs 的交接；旧位置 task-<id>.md 也兼容。 */
function readTaskReport(dir: string, id: number): string {
  for (const file of [path.join(dir, "handoffs", `task-${id}.md`), path.join(dir, `task-${id}.md`)]) {
    try { return fs.readFileSync(file, "utf8").trim(); } catch { /* 试下一个位置 */ }
  }
  return "";
}

/**
 * 日额度的两条保险丝：dailyTokens / dailyLlmCalls 配成负数 = 不设这条闸，
 * 只留钱那条（dailyCny）。0 仍然是「一分都不给」。
 */
function tokensLeftOf(cfg: Config, used: number): number {
  const cap = cfg.limits.dailyTokens;
  return cap < 0 ? Number.POSITIVE_INFINITY : cap - used;
}

function callsLeftOf(cfg: Config, used: number): number {
  const cap = cfg.limits.dailyLlmCalls;
  return cap < 0 ? Number.POSITIVE_INFINITY : cap - used;
}

export class App {
  readonly store: Store;
  readonly hub: Hub;
  readonly log: Logger;
  readonly queue: RunQueue;
  readonly scheduler: Scheduler;
  readonly engine: AgentEngine;
  readonly emoji: EmojiTable;
  /** 宿主机命令的审批闸门（host 模式下 terminal 才会用它） */
  readonly approval: ApprovalGate;
  /** 任务发布审批闸门：任务先发到原聊天/审批房，主人在 IM 里裁决 */
  readonly taskApproval: TaskApprovalGate;
  /** 出站消息审核闸门：开关打开时，agent 发出的消息先预览给主人贴 OK 才发 */
  readonly sendReview: SendReviewGate;
  /** 发完消息后的看门狗：静默 10s 后复核是否可以直接执行等点头的项目动作 */
  readonly watchdog: AgentWatchdog;
  private clock: Clock;
  /** 当前正在处理的唤醒 */
  private activeWake: Wake | null = null;
  /** 本轮读进来的未读消息：记记忆时绑来源 seq，唤醒结束即清空 */
  private currentUnread: StoredMessage[] = [];
  /** 本轮是否决定不回（chat action=skip）；每轮唤醒重置 */
  private silenceReason: string | null = null;
  /** 本轮 send 成功次数 */
  private sendsThisTurn = 0;
  /** 后台记忆梳理：计数状态、是否在跑、临时上下文和专用工具集 */
  private memoryReviewState: MemoryReviewState = { turns: 0, lastReviewAt: 0, lastOutcome: "" };
  private reviewBusy = false;
  private reviewCtx: { pool: string | null; unread: StoredMessage[] } = { pool: null, unread: [] };
  private reviewTools: ReturnType<typeof createTools> = [];
  /** 每次唤醒结束后的回调（模拟器/测试用） */
  onWakeDone?: (entry: any) => void;

  constructor(private o: AppOptions) {
    const cfg = o.cfg;
    this.clock = o.clock ?? realClock;
    this.log = o.logger ?? new Logger(cfg.logDir);
    this.store = new Store(o.dbFile ?? path.join(cfg.dataDir, "rabbit-bot.db"));
    this.store.backfillUsageEventsFromWakeLog();
    // 业务地图：老库第一次启动从 runtime/business 文件导一次，之后只读 SQLite
    try { ensureBusinessSeeded(this.store, businessDir(cfg)); } catch (e) { this.log.warn(`业务地图导入失败：${(e as Error).message}`); }
    // WA 共用工作区：handoffs/ + 默认最佳实践（缺失才落，已有不覆盖）
    try { ensureSharedWorkspace(cfg); } catch (e) { this.log.warn(`shared 工作区初始化失败：${(e as Error).message}`); }
    // 跨会话工作记忆：运行时根目录的 memory.md，所有主体共用
    try {
      const file = ensureWorkingMemory(cfg);
      this.log.info(`工作记忆：${file}`);
    } catch (e) { this.log.warn(`工作记忆初始化失败：${(e as Error).message}`); }
    this.emoji = EmojiTable.load(cfg.emoji.table, cfg.emoji.map);
    this.hub = new Hub(this.store, cfg, this.log, this.emoji);
    this.queue = new RunQueue((w) => this.handleWake(w));
    this.queue.onError = (e) => this.log.error("唤醒处理异常", e);
    this.approval = new ApprovalGate(
      cfg.approval,
      this.log,
      (chatId, text) => this.hub.sendSystem(cfg.approval.platform, chatId, text),
      path.join(cfg.dataDir, "approval.jsonl"),
      {
        store: this.store,
        enqueue: () => this.queue.enqueue(makeWake("task-updated", [], "approval")),
      },
    );
    this.taskApproval = new TaskApprovalGate(
      cfg.taskApproval,
      this.log,
      // 任务审批提示要让 agent 自己也看得到（Matrix 靠 sync 回灌天然可见，飞书不回收自己的消息）
      (target, text, meta) => this.sendTaskNotice(target, text, meta),
      {
        onApprove: (task, by) => this.approveTaskFromChat(task, by),
        onReject: (task, by) => this.rejectTaskFromChat(task, by),
        onTimeout: (task) => this.timeoutTaskFromChat(task),
      },
    );
    const sendReviewCfg = resolveSendReviewConfig(cfg);
    this.sendReview = new SendReviewGate(
      sendReviewCfg,
      this.log,
      (target, text) => this.hub.sendSystem(target.platform, target.chatId, text),
      // 主对话池：审批预览也发到这里；没指定主对话时才退回固定审批房
      () => {
        const primaryId = String(cfg.sendReview?.primaryPoolId ?? "").trim();
        if (!primaryId) return null;
        const pool = this.store.getPool(primaryId);
        return pool ? { platform: pool.platform, chatId: pool.external_id } : null;
      },
    );
    // 钩子一直挂着：总开关和「哪些池要审」由 Web 管理台实时改 cfg.sendReview，
    // 不能只在启动时按当时的 enabled 决定挂不挂，否则前端打开后要重启才生效。
    this.hub.review = {
      shouldReview: (poolId) => reviewRequiredFor(effectiveSendReviewSettings(cfg), poolId),
      propose: (req) => this.sendReview.propose(req),
    };
    if (cfg.sendReview?.enabled && !this.sendReview.enabled) {
      // 开关打开但审批房没配好时不要悄悄放行——propose 会直接报错，所有出站消息被拦下
      this.log.warn("sendReview 开着但缺 platform / roomId / ownerIds：agent 的出站消息都会被拦下不发送");
    } else if (cfg.sendReview?.enabled) {
      this.log.info(`出站消息审核已开启：${sendReviewCfg.platform} / ${sendReviewCfg.roomId}，超时 ${sendReviewCfg.timeoutMs}ms 不发送`);
    }
    // 三个闸门可以共用一个审批房：任务审批 → 出站审核 → 命令审批。
    // 只有闸门明确认领的裁决消息才不进池；其余消息照常入池。
    // 审批房也可能是私聊，不能因为聊天 id 命中审批配置就把正常对话吞掉。
    this.hub.approval = {
      tryHandle: (m) => this.taskApproval.tryHandle(m) || this.sendReview.tryHandle(m) || this.approval.tryHandle(m),
    };
    this.scheduler = new Scheduler(cfg.scheduler, {
      clock: this.clock, queue: this.queue, isPaused: () => this.store.isPaused(),
      poolsWithUnread: () => this.store.poolsWithUnread(),
      poolKind: (id) => this.store.getPool(id)?.kind,
      dueSchedules: (now) => this.store.dueSchedules(now),
      fireSchedule: (s, now) => {
        const updated = fireSchedule(this.store, s, now, cfg.timezone);
        appendScheduleEvent(this.store, s, now);
        if (updated) this.log.info(`日程 #${s.id}「${s.title}」下一次 ${updated.next_at}（${updated.status}）`);
      },
      schedulePoolId: ensureSchedulePool(this.store),
      log: (m) => this.log.info(`[sched] ${m}`), warn: (m) => this.log.warn(`[sched] ${m}`),
    });
    this.hub.scheduler = this.scheduler;
    setTaskEventNotifier(this.store, () => this.scheduler.notifyTaskEvent());
    const baseToolDeps = {
      store: this.store, hub: this.hub, cfg, now: () => this.clock.now(),
      currentWake: () => this.activeWake,
      currentUnread: () => this.currentUnread,
      silenceReason: () => this.silenceReason,
      markSilent: (reason: string) => { this.silenceReason = reason; },
      rbExec: o.rbExec,
      approval: this.approval,
      // 工具只负责“建完要发通知”，发到哪由 App 按 target=origin/room 解析
      taskApproval: {
        enabled: this.taskApproval.enabled,
        notify: (task: Task) => this.notifyTaskApprovalNow(task),
      },
      enqueue: () => this.queue.enqueue(makeWake("task-updated", [], "approval")),
      scheduleChanged: () => this.scheduler.notifyScheduleChange(),
    };
    const tools = createTools({
      ...baseToolDeps,
      profile: "ufa",
      readRoot: runtimeDir(cfg),
      primaryPool: () => resolvePrimaryPool(this.store, this.activeWake),
    });
    // 后台记忆梳理：独立工具集，只有 memory；上下文由 reviewCtx 提供。
    this.memoryReviewState = loadMemoryReviewState(cfg);
    this.reviewTools = createTools({
      ...baseToolDeps,
      profile: "review",
      currentUnread: () => this.reviewCtx.unread,
      primaryPool: () => this.reviewCtx.pool,
    });
    this.engine = new PiEngine({
      cfg, store: this.store, log: this.log, tools, systemPrompt: () => systemPrompt(cfg, this.emoji.commonIds(), this.store),
      model: o.model, modelRuntime: o.modelRuntime, inMemorySessions: o.inMemorySessions,
      onUsage: (u) => this.store.addUsageEvent({ ...u, source: "llm" }),
    });
    this.watchdog = new AgentWatchdog({
      clock: this.clock, store: this.store, log: this.log,
      settings: () => effectiveWatchdogSettings(cfg),
      isPaused: () => this.store.isPaused(),
      review: (poolId, lastSelf) => this.reviewWithWatchdog(poolId, lastSelf),
      nudge: (poolId, reason) => this.nudgeFromWatchdog(poolId, reason),
    });
    this.hub.onSent = (poolId, _text, seq) => {
      const sentSeq = seq ?? this.store.lastSelfMessageRow(poolId)?.seq ?? 0;
      this.watchdog.onSent(poolId, sentSeq, this.clock.now());
    };
  }

  /** 管理台：当前可用（有凭据）的模型，用于校验和展示。 */
  async listAvailableModels(): Promise<{ provider: string; model: string; name: string }[]> {
    const available = await this.o.modelRuntime.getAvailable();
    return available.map((m) => ({
      provider: m.provider,
      model: m.id,
      name: (m as { name?: string }).name || m.id,
    }));
  }

  /** 管理台：切换主模型。先解析并校验凭据，成功后才重建会话。 */
  async switchModel(provider: string, model: string): Promise<ModelSettings> {
    const current = effectiveModelSettings(this.o.cfg);
    if (current.provider === provider && current.model === model) return current;
    if (this.queue.isBusy()) throw new Error("正在处理一条唤醒，等这轮结束后再切换");
    const cfg = this.o.cfg;
    const resolved = await resolveModel({
      ...cfg,
      llm: { ...cfg.llm, provider, model },
    } as Config);
    // 解析模型要读磁盘/探测凭据，期间可能又进来一轮唤醒：切会话前再确认一次
    if (this.queue.isBusy()) throw new Error("正在处理一条唤醒，等这轮结束后再切换");
    const next = saveModelSettings(cfg, { provider, model, choices: current.choices });
    this.engine.switchModel(resolved.model, resolved.modelRuntime);
    this.o.model = resolved.model;
    this.o.modelRuntime = resolved.modelRuntime;
    return next;
  }

  async start() {
    await this.hub.startAdapters();
    this.scheduler.start();
    this.startApprovalSweep();
    this.startRunnerWatch();
    this.recoverPendingTaskApprovals();
    this.log.info(`rabbit-bot 已启动 tick=${this.o.cfg.scheduler.tickMs}ms taskTick=${this.o.cfg.scheduler.taskTickMs}ms privateWake=${this.o.cfg.scheduler.privateWakeMs}ms debounce=${this.o.cfg.scheduler.debounceMs}ms 消息tick批=${this.o.cfg.scheduler.batchToTick ? "on" : "off"} 缓存折算=${this.o.cfg.limits.cacheReadRate} 换会话=${this.o.cfg.handoff.sessionTokenLimit}tok 日额度=${this.o.cfg.limits.dailyTokens}tok 日花费上限=¥${this.o.cfg.limits.dailyCny ?? 0} 汇率=${this.o.cfg.limits.usdCny ?? 7.1} paused=${this.store.isPaused()}`);
  }

  async stop() {
    this.watchdog.stop();
    this.scheduler.stop();
    if (this.approvalSweepTimer) { clearInterval(this.approvalSweepTimer as any); this.approvalSweepTimer = null; }
    if (this.runnerWatchTimer) { clearInterval(this.runnerWatchTimer as any); this.runnerWatchTimer = null; }
    await this.queue.idle();
    await this.hub.stopAdapters();
    await this.engine.dispose();
    setTaskEventNotifier(this.store, null);
    this.store.close();
  }

  // ---------- 审批超时 ----------

  private approvalSweepTimer: unknown = null;

  /** 10–30s 扫一次：过期的 pending 落成 timeout（拒绝），并合并成一次 task-updated。 */
  private startApprovalSweep(): void {
    const t = setInterval(() => this.sweepApprovals(), 15_000);
    (t as any).unref?.();
    this.approvalSweepTimer = t;
  }

  private sweepApprovals(): void {
    try {
      const n = sweepExpirations(this.store, this.clock.now(), () => {
        this.queue.enqueue(makeWake("task-updated", [], "approval timeout"));
      });
      if (n > 0) this.log.info(`审批超时 ${n} 条，已按拒绝处理`);
    } catch (e) {
      this.log.warn(`审批超时清扫失败：${(e as Error).message}`);
    }
  }

  // ---------- 执行器进程存活巡检 ----------

  private runnerWatchTimer: unknown = null;

  /**
   * 周期性批量探活：启动时先扫一遍（补上一次进程重启留下的孤儿 running 任务），
   * 之后按 scheduler.runnerWatchMs（默认 30s）扫。
   */
  private startRunnerWatch(): void {
    const every = this.o.cfg.scheduler.runnerWatchMs ?? 30_000;
    if (!(every > 0)) return;
    this.sweepRunners();
    const t = setInterval(() => this.sweepRunners(), every);
    (t as any).unref?.();
    this.runnerWatchTimer = t;
  }

  private sweepRunners(): void {
    try {
      const r = sweepDeadRunners(this.store, { dataDir: this.o.cfg.dataDir });
      if (r.attached.length) {
        this.log.info(`执行器接管：${r.attached.length} 个进程还活着，已重新挂上探活（${r.attached.map((id) => `#${id}`).join(" ")}）`);
      }
      if (r.dead.length) {
        this.log.info(`执行器存活巡检：${r.dead.length}/${r.checked} 个进程已退出，任务池已收到调度器消息（${r.dead.map((id) => `#${id}`).join(" ")}）`);
      }
    } catch (e) {
      this.log.warn(`执行器存活巡检失败：${(e as Error).message}`);
    }
    const thresholdMs = this.o.cfg.scheduler.longTaskWarnMs ?? 600_000;
    if (!(thresholdMs > 0)) return;
    try {
      const r = sweepLongRunningTasks(this.store, { now: this.clock.now(), thresholdMs });
      if (r.warned.length) {
        this.log.info(`长任务巡检：${r.warned.length} 个任务超过 ${Math.round(thresholdMs / 60_000)} 分钟，已写进任务池并唤醒 UFA（${r.warned.map((id) => `#${id}`).join(" ")}）`);
      }
    } catch (e) {
      this.log.warn(`长任务巡检失败：${(e as Error).message}`);
    }
  }

  // ---------- 任务发布审批 ----------

  /**
   * 审批结果只回一句短消息到主聊天，不走模型。
   * 任务名可能很长，裁决回执只需要任务号和结果，避免挤占上下文；
   * 回执本身要入池留痕（她得知道自己批准/取消了什么），但不进未读、不触发唤醒。
   */
  /**
   * 任务通知（审批提示 / 裁决回执）的双通道发送。
   *
   * 主聊天在 IM 上时，同一条通知也往网页直聊池写一份：IM 渠道整体不可用时，
   * 主人仍然能在网页里看到待审任务并点同意/拒绝，不用等飞书恢复。
   * 主聊天本来就是网页直聊时不重复发。
   */
  private async sendTaskNotice(
    target: TaskApprovalTarget,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; msgId?: string }> {
    const sent = await this.hub.sendSystem(target.platform, target.chatId, text, { remember: true, meta });
    if (target.platform === "web") return sent;

    let ws: ReturnType<typeof effectiveWebChat>;
    try { ws = effectiveWebChat(this.o.cfg); } catch { return sent; }
    if (!ws.enabled) return sent;

    const pool = this.store.upsertPool("web", ws.pool, "private", ws.title);
    // 网页里没有表情可贴，裁决提示只保留超时口径；按钮由前端渲染
    let webText = text;
    if (meta?.kind === "task_approval" && typeof meta.task_id === "number") {
      const task = getTask(this.store, meta.task_id);
      if (task) webText = formatTaskApprovalText(task, taskApprovalTimeoutMs(this.o.cfg.taskApproval), "web");
    }
    const copy = await this.hub.sendSystem("web", pool.external_id, webText, { remember: true, meta });
    if (!copy.ok) {
      this.log.warn(`任务通知同步到网页直聊失败：${copy.error ?? "未知原因"}`);
    } else if (!sent.ok) {
      this.log.warn(`主聊天发送失败（${sent.error ?? "未知原因"}），任务通知已改投网页直聊`);
    }
    return sent.ok ? sent : copy;
  }

  private notifyTaskDecisionShort(taskId: number, decision: TaskDecision): void {
    const target = this.resolveTaskNoticeTarget();
    if (!target) return;
    const text = decision === "approved"
      ? `任务 #${taskId} 审批通过，准备启动`
      : decision === "timeout"
        ? `任务 #${taskId} 审批超时，已取消`
        : `任务 #${taskId} 已取消`;
    void this.sendTaskNotice(target, text)
      .then((r) => { if (!r.ok) this.log.warn(`任务 #${taskId} 裁决回执发送失败：${r.error ?? "未知原因"}`); })
      .catch((e) => this.log.warn(`任务 #${taskId} 裁决回执发送失败：${(e as Error).message}`));
  }

  /** Web/API 裁决后：清掉 IM 里的待审提示，并回一句短线。 */
  onTaskDecided(taskId: number, decision: TaskDecision): void {
    this.forgetTaskApproval(taskId);
    this.notifyTaskDecisionShort(taskId, decision);
  }

  /** 任务被 UFA / API 建好后调这里：把审批请求发到原聊天或固定审批房（不阻塞当前对话）。 */
  notifyTaskApproval(task: Task): void {
    void this.notifyTaskApprovalNow(task).catch((e) => {
      this.log.warn(`任务 #${task.id} 审批通知失败：${(e as Error).message}`);
    });
  }

  /** 工具/API 要的同步返回值：发出去 true，没目标/发失败 false。 */
  private async notifyTaskApprovalNow(task: Task): Promise<boolean> {
    if (task.status !== "pending_approval") return false;
    const target = this.resolveTaskApprovalTarget(task);
    if (!target) {
      this.log.warn(`任务 #${task.id} 没有审批目标：发起聊天找不到，taskApproval.roomId 也没配`);
      return false;
    }
    return this.taskApproval.notify(task, target);
  }

  /**
   * 任务审批提示一律发主聊天：任务从群聊发起也只发主聊天，避免审批提示泄露到项目群。
   * 主聊天没设（sendReview.primaryPoolId 为空）时退回 taskApproval.roomId。
   */
  private resolveTaskApprovalTarget(_task: Task): TaskApprovalTarget | null {
    return this.resolveTaskNoticeTarget();
  }

  /** 审批提示和裁决回执都优先主聊天，主聊天没设时退回固定审批房。 */
  private resolveTaskNoticeTarget(): TaskApprovalTarget | null {
    const mainId = mainPoolId(this.o.cfg);
    if (mainId) {
      let pool = this.store.getPool(mainId);
      // 网页直聊池可能还没人说过话：主聊天指到它时按配置补建，否则通知会静默丢掉
      if (!pool && mainId.startsWith("web:")) {
        const ext = mainId.slice("web:".length);
        const ws = effectiveWebChat(this.o.cfg);
        if (ws.enabled) pool = this.store.upsertPool("web", ext, "private", ws.pool === ext ? ws.title : ext);
      }
      if (pool?.external_id) return { platform: pool.platform, chatId: pool.external_id };
    }
    const ta = this.o.cfg.taskApproval;
    const roomId = String(ta.roomId ?? "").trim();
    return roomId ? { platform: ta.platform, chatId: roomId } : null;
  }

  /** 任务已经在 Web 或别处裁决：把飞书里那条待审忘掉，避免之后误批/超时刷屏。 */
  forgetTaskApproval(taskId: number): void {
    this.taskApproval.cancel(taskId);
  }

  /**
   * 重启后把还停在 pending_approval 的任务重新发一遍。
   * 进程内没有待审状态，不发的话主人就只能在 Web 里找到它。
   */
  private recoverPendingTaskApprovals(): void {
    if (!this.taskApproval.enabled) return;
    const now = this.clock.now();
    const timeoutMs = Math.max(1000, this.o.cfg.taskApproval.timeoutMs || 86_400_000);
    for (const task of listTasks(this.store, { status: "pending_approval" })) {
      if (task.created_at + timeoutMs <= now) {
        void this.timeoutTaskFromChat(task);
        continue;
      }
      this.notifyTaskApproval(task);
    }
  }

  private taskDispatchDeps(): DispatchDeps {
    return {
      apiBase: `http://127.0.0.1:${this.o.cfg.api?.port ?? 3738}`,
      token: resolveApiToken(this.o.cfg),
      dataDir: this.o.cfg.dataDir,
      executorBin: this.o.executorBin,
      runtimeDir: this.o.cfg.runtimeDir,
      sharedDir: sharedDir(this.o.cfg),
      businessDir: businessDir(this.o.cfg),
    };
  }

  /** 审批提示上贴了 OK：补齐文档、启动一次性进程。 */
  private async approveTaskFromChat(task: Task, by: string): Promise<TaskApprovalOutcome> {
    const current = getTask(this.store, task.id);
    if (!current) return { ok: false, text: `#${task.id} 已经不存在，没有执行` };
    if (current.status !== "pending_approval") {
      return { ok: false };
    }
    // 平台名不能写死：审批提示现在可能发在 Matrix 主聊天（上游 c5ee7e8 之后一律发主聊天），
    // 写死「飞书」会让审计轨迹和事实对不上（任务 #4，2026-11-15）。
    const platformLabel = String(this.o.cfg.taskApproval.platform ?? "").trim() === "matrix" ? "Matrix" : "飞书";
    appendNote(this.store, current.id, `${platformLabel}审批通过（by=${by}）`);
    try {
      const deps = this.taskDispatchDeps();
      writeTaskDoc(this.store, current, {
        apiBase: deps.apiBase, runtimeDir: deps.runtimeDir, sharedDir: deps.sharedDir, businessDir: deps.businessDir,
      });
      await startTask(this.store, getTask(this.store, current.id)!, deps);
      this.notifyTaskDecisionShort(current.id, "approved");
      return { ok: true };
    } catch (e) {
      const message = (e as Error).message;
      const fresh = getTask(this.store, current.id);
      if (!fresh || !runnerAlive(fresh, this.o.cfg.dataDir)) {
        updateTask(this.store, current.id, {
          status: "pending_approval", runner_pid: null, runner_started_at: null,
        });
      }
      appendNote(this.store, current.id, `启动失败：${message}`);
      // 任务退回 pending_approval 后重新发一次提示，主人可以直接重试
      const retry = getTask(this.store, current.id);
      if (retry?.status === "pending_approval") this.notifyTaskApproval(retry);
      return { ok: false, text: `#${current.id} 启动失败：${message}` };
    }
  }

  /** 审批提示上贴了 No：任务取消，不执行。 */
  private async rejectTaskFromChat(task: Task, by: string): Promise<TaskApprovalOutcome> {
    const current = getTask(this.store, task.id);
    if (!current) return { ok: false, text: `#${task.id} 已经不存在，没有执行` };
    if (current.status !== "pending_approval") return { ok: false };
    updateTask(this.store, current.id, { status: "cancelled" });
    appendNote(this.store, current.id, `飞书审批拒绝（by=${by}），未执行`);
    this.notifyTaskDecisionShort(current.id, "rejected");
    return { ok: true };
  }

  /** 超时 = 拒绝（fail-closed）；任务已经不在待审状态就不回消息。 */
  private async timeoutTaskFromChat(task: Task): Promise<TaskApprovalOutcome> {
    const current = getTask(this.store, task.id);
    if (!current || current.status !== "pending_approval") return { ok: false };
    updateTask(this.store, current.id, { status: "cancelled" });
    appendNote(this.store, current.id, "审批超时，按拒绝处理，未执行");
    this.notifyTaskDecisionShort(current.id, "timeout");
    return { ok: false };
  }

  // ---------- 后台记忆梳理 ----------

  /** 每轮唤醒后累加用户回合；到点由 maybeMemoryReview 决定跑不跑。 */
  private noteInboundMessages(unread: StoredMessage[]): void {
    const inbound = unread.filter((m) => !m.from_self && m.sender_id !== "system").length;
    if (!inbound) return;
    this.memoryReviewState = { ...this.memoryReviewState, turns: this.memoryReviewState.turns + inbound };
    try { saveMemoryReviewState(this.o.cfg, this.memoryReviewState); } catch { /* 状态写失败不影响唤醒 */ }
  }

  private pickReviewPool(unread: StoredMessage[]): string | null {
    const inbound = unread.filter((m) => !m.from_self && m.user_id && m.sender_id !== "system");
    if (inbound.length) return inbound[inbound.length - 1].pool_id;
    return resolvePrimaryPool(this.store, this.activeWake) ?? null;
  }

  /**
   * 后台记忆梳理：到点就 fork 一个只带 memory 的临时会话。
   * 技能和业务关系不在这里做，也不额外起后台会话。
   */
  private async maybeMemoryReview(unread: StoredMessage[]): Promise<void> {
    const cfg = this.o.cfg;
    const settings = effectiveMemoryReviewSettings(cfg);
    const now = this.clock.now();
    if (this.reviewBusy || this.store.isPaused() || !memoryReviewDue(settings, this.memoryReviewState, now)) return;

    const day = dayKey(now, cfg.timezone);
    const usage = this.store.getUsage(day);
    const tokensLeft = tokensLeftOf(cfg, usage.tokens);
    const callsLeft = callsLeftOf(cfg, usage.llm_calls);
    if (tokensLeft < 3000 || callsLeft < 1) return;

    const poolId = this.pickReviewPool(unread);
    if (!poolId) return;

    this.reviewBusy = true;
    this.memoryReviewState = { ...this.memoryReviewState, turns: 0, lastReviewAt: now, lastOutcome: "running" };
    try { saveMemoryReviewState(cfg, this.memoryReviewState); } catch { /* ignore */ }
    try {
      const rows = this.store.recentMessages(poolId, 30);
      const recent = rows.map((m) =>
        `${fmtShort(m.ts)} ${m.from_self ? cfg.agent.name : (this.store.userDisplayName(m.platform, m.sender_id) || m.sender_name || m.user_id || "对方")}：${m.text.slice(0, 300)}`,
      ).join("\n");
      this.reviewCtx = { pool: poolId, unread: rows };
      const prompt = render("memory-review", {
        now: new Intl.DateTimeFormat("zh-CN", {
          timeZone: cfg.timezone, dateStyle: "medium", timeStyle: "short",
        }).format(new Date(now)),
        pool: this.store.poolAlias(poolId),
        recent: recent || "（没有最近消息）",
      });
      const res = await this.engine.review(
        prompt, { tokensLeft, callsLeft }, this.reviewTools, render("memory-review-system", {}),
      );
      this.store.addUsage(day, res.llmCalls, res.tokens, 0, this.usageExtra(res));
      this.memoryReviewState = { ...this.memoryReviewState, lastOutcome: res.error ? `error:${res.error}` : "ok" };
      this.log.info(`记忆梳理${res.error ? `失败：${res.error}` : "完成"}（${this.store.poolAlias(poolId)}，${res.llmCalls} 次调用）`);
    } catch (e) {
      this.memoryReviewState = { ...this.memoryReviewState, lastOutcome: `error:${(e as Error).message}` };
      this.log.warn(`记忆梳理失败：${(e as Error).message}`);
    } finally {
      this.reviewCtx = { pool: null, unread: [] };
      this.reviewBusy = false;
      try { saveMemoryReviewState(cfg, this.memoryReviewState); } catch { /* ignore */ }
    }
  }

  // ---------- 发完消息后的看门狗 ----------

  /**
   * 独立临时会话复核最后一条消息：只判断「万事俱备，只欠用户点头」的项目内动作。
   * 没有工具，不能发消息；解析失败一律按不放行处理。
   */
  private async reviewWithWatchdog(poolId: string, lastSelf: StoredMessage): Promise<WatchdogDecision | null> {
    const cfg = this.o.cfg;
    const now = this.clock.now();
    if (!effectiveWatchdogSettings(cfg).enabled || this.store.isPaused()) return null;

    const day = dayKey(now, cfg.timezone);
    const usage = this.store.getUsage(day);
    const tokensLeft = tokensLeftOf(cfg, usage.tokens);
    const callsLeft = callsLeftOf(cfg, usage.llm_calls);
    if (tokensLeft < 1500 || callsLeft < 1) return null;

    const pool = this.store.getPool(poolId);
    if (!pool) return null;
    const rows = this.store.recentMessages(poolId, 13, lastSelf.seq)
      .filter((m) => m.seq !== lastSelf.seq);
    const recent = rows.map((m) =>
      `${fmtShort(m.ts)} ${m.from_self ? cfg.agent.name : (this.store.userDisplayName(m.platform, m.sender_id) || m.sender_name || m.user_id || "对方")}：${m.text.slice(0, 300)}`,
    ).join("\n");
    const prompt = render("watchdog", {
      now: new Intl.DateTimeFormat("zh-CN", {
        timeZone: cfg.timezone, dateStyle: "medium", timeStyle: "short",
      }).format(new Date(now)),
      pool: this.store.poolAlias(poolId),
      kind: pool.kind === "private" ? "私聊" : pool.kind === "group" ? "群聊" : pool.kind,
      last: lastSelf.text.slice(0, 1200),
      recent: recent || "（没有更早的消息）",
    });
    const res = await this.engine.review(prompt, { tokensLeft, callsLeft }, [], render("watchdog-system", {}));
    this.store.addUsage(day, res.llmCalls, res.tokens, 0, this.usageExtra(res));
    if (res.error || res.aborted) {
      this.log.warn(`看门狗复核失败：${res.error ?? res.abortReason ?? "unknown"}`);
      return null;
    }
    const json = extractJsonObject(res.assistantText);
    if (!json) return null;
    let raw: any;
    try { raw = JSON.parse(json); } catch { return null; }
    const action = String(raw?.action ?? "").trim().toLowerCase();
    if (action !== "execute" && action !== "wait") return null;
    const reason = String(raw?.reason ?? "").trim().slice(0, 200);
    return { execute: action === "execute", reason: reason || (action === "execute" ? "条件满足" : "没有明确在等点头") };
  }

  /** 往原池插一条系统消息并立即唤醒；不经过适配器，用户不会在 IM 里看到它。 */
  private nudgeFromWatchdog(poolId: string, reason: string): void {
    const pool = this.store.getPool(poolId);
    if (!pool) return;
    const now = this.clock.now();
    const text = "〔系统〕看门狗：你上一条在等用户点头的项目内动作，已经自动放行。"
      + "直接执行，不要往聊天池发消息；如果已经做过或不需要再等，忽略这条，不要重复建任务。"
      + `复核理由：${reason.slice(0, 200)}`;
    const saved = this.store.insertMessage({
      platform: pool.platform, external_chat_id: pool.external_id, pool_kind: pool.kind, pool_title: pool.title,
      msg_id: `watchdog:${poolId}:${now}:${Math.random().toString(36).slice(2, 8)}`,
      sender_id: "system", sender_name: "系统", ts: now, text, reply_to: null,
      mentions: [], is_mention_me: false, media_type: "text", from_self: false,
    });
    if (!saved) return;
    this.log.info(`看门狗插入系统消息 ${this.store.poolAlias(poolId)} #${saved.seq}`);
    this.queue.enqueue(makeWake("message", [poolId], "看门狗：放行项目内动作", [], now));
  }

  /**
   * 一次运行 → 记账用的四个数（2026-11-07）。
   * 三段 token 由 pi 报的 usage 拆出来；美元成本按官方单价表 × 当前时段自己算一遍，
   * 不用 pi 自带的 cost（它认不认识峰谷、认不认识新价目表，都不该由我们猜）。
   */
  private usageExtra(res: { cacheHit?: number; cacheMiss?: number; outTokens?: number }) {
    const cfg = this.o.cfg;
    const split = { hit: res.cacheHit ?? 0, miss: res.cacheMiss ?? 0, out: res.outTokens ?? 0 };
    const usd = costUsd(cfg.llm.model, split, Date.now(), cfg.limits.offPeakHolidays ?? []);
    return { cacheHit: split.hit, cacheMiss: split.miss, outTokens: split.out, costUsd: usd };
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
    const waiting = this.store.poolsWithUnread()
      .filter((id) => !["task", "schedule"].includes(this.store.getPool(id)?.kind ?? ""));
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
    const waiting = this.store.poolsWithUnread()
      .filter((id) => !["task", "schedule"].includes(this.store.getPool(id)?.kind ?? ""));
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

  /** 任务汇报游标；从来没转过就是 null。 */
  private relayCursor(): number | null {
    const raw = this.store.getKv(TASK_RELAY_CURSOR_KEY);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 把 since 之后的终态任务合成一轮转述。
   *
   * 防洪水靠这里：任务事件本身按任务 tick 批量到达；这里再按池合并、
   * 每池最多列 10 条、两次转述至少隔 5 分钟。返回 true 表示这一轮已经处理完
   * （包括冷却跳过），false 表示没有终态任务，调用方继续走原来的未读池逻辑。
   */
  private async relayTaskUpdates(
    since: number,
    finish: (outcome: string, extra?: Record<string, unknown>) => void,
    t0: number,
  ): Promise<boolean> {
    const cfg = this.o.cfg;
    const tasks = listTasksUpdatedSince(this.store, since, ["done", "failed", "blocked"]);
    if (!tasks.length) return false;

    const last = Number(this.store.getKv(TASK_RELAY_LAST_KEY) ?? 0);
    if (last > 0 && t0 - last < TASK_RELAY_COOLDOWN_MS) {
      // 先重新置位，下一次任务 tick 再试；游标不动，这批任务不会丢
      markPendingTick(this.store, t0);
      finish("skipped:task-relay-cooldown", {
        tasks: tasks.length,
        nextInMs: TASK_RELAY_COOLDOWN_MS - (t0 - last),
      });
      return true;
    }

    const shared = sharedDir(cfg);
    const byPool = new Map<string, Task[]>();
    for (const t of tasks) {
      const list = byPool.get(t.pool_id) ?? [];
      list.push(t);
      byPool.set(t.pool_id, list);
    }

    const mainId = mainPoolId(cfg);
    const mainAlias = mainId ? this.store.poolAlias(mainId) : null;
    const lines: string[] = [
      "【任务汇报】下面这些任务刚刚结束，挑值得说的转述给主聊天。",
      mainAlias
        ? `规则：只转述 done/failed/blocked；全部汇报只发主聊天 ${mainAlias}，不要发任务来源池或群聊；这一批合并成一条，最多列 10 个，其余写「还有 N 个」。`
        : "规则：主聊天还没设，这批先别发聊天消息；只在任务里记一笔，等主人设好主聊天再汇报。",
      "不要复述汇报全文，不要提 token；这一批都不值得说就 skip。",
      "",
    ];
    for (const [pid, list] of byPool) {
      const pool = this.store.getPool(pid);
      const alias = this.store.poolAlias(pid);
      lines.push(
        `- 来源池 ${alias}${pool ? `「${this.store.poolDisplayTitle(pool)}」` : ""}（${list.length} 个任务；`
        + `只是出处，汇报目标仍是主聊天 ${mainAlias ?? "未设，先别发"}）`,
      );
      for (const t of list.slice(0, TASK_RELAY_MAX_LISTED)) {
        lines.push(`  - ${taskDisplayName(t)}：${t.status}`);
        if (t.result?.trim()) lines.push(`    结果：${clipText(t.result, 200)}`);
        if (t.artifact?.trim()) lines.push(`    产出：${clipText(t.artifact, 200)}`);
        const report = readTaskReport(shared, t.id);
        if (report) lines.push(`    汇报：${clipText(report, TASK_RELAY_REPORT_CHARS)}`);
      }
      if (list.length > TASK_RELAY_MAX_LISTED) {
        lines.push(`  - 还有 ${list.length - TASK_RELAY_MAX_LISTED} 个任务未逐条列出`);
      }
    }

    const day = dayKey(t0, cfg.timezone);
    const usage = this.store.getUsage(day);
    let res: RunResult;
    try {
      res = await this.engine.run(lines.join("\n"), {
        tokensLeft: tokensLeftOf(cfg, usage.tokens),
        callsLeft: callsLeftOf(cfg, usage.llm_calls),
      });
    } catch (e) {
      markPendingTick(this.store, t0);
      finish("error:task-relay", { error: (e as Error).message, tasks: tasks.length });
      return true;
    }
    this.store.addUsage(day, res.llmCalls, res.tokens, 1, this.usageExtra(res));

    const sendCalls = res.toolCalls.filter((c) => isChatCall(c, "send") && !c.isError);
    // 工具返回 details.ok=false 的（被新消息压住 / 适配器失败）不算真发出去
    const delivered = sendCalls.filter((c) => /^已发送/.test(String(c.result ?? "")));
    const undelivered = sendCalls.length - delivered.length;

    if (!delivered.length && (res.error || undelivered > 0)) {
      // 一条都没真发出去：保留任务池未读，下一次任务 tick 会再触发这条链路
      markPendingTick(this.store, t0);
      finish("error:task-relay", {
        error: res.error ?? "send-not-delivered",
        held: undelivered,
        tasks: tasks.map((t) => ({ id: t.id, status: t.status })),
        llmCalls: res.llmCalls,
        tokens: res.tokens,
      });
      return true;
    }

    // 这次读过的任务池游标推过去，免得下一轮把它当普通未读再跑一遍
    for (const t of tasks) this.hub.takeUnread([t.task_pool_id]);

    const maxUpdated = Math.max(...tasks.map((t) => t.updated_at), since);
    this.store.setKv(TASK_RELAY_CURSOR_KEY, String(maxUpdated + 1));
    this.store.setKv(TASK_RELAY_LAST_KEY, String(t0));
    this.sendsThisTurn = delivered.length;
    finish("task-updated:relayed", {
      taskTickAt: since,
      tasks: tasks.map((t) => ({ id: t.id, status: t.status, pool: t.pool_id })),
      relayed: delivered.length > 0,
      sent: delivered.map((c) => c.args),
      llmCalls: res.llmCalls,
      tokens: res.tokens,
    });
    return true;
  }

  /** 唤醒处理：纯代码决定要不要调用 LLM；真正需要时才调用 pi。 */
  async handleWake(w: Wake): Promise<void> {
    this.activeWake = w;
    this.currentUnread = [];
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
      this.currentUnread = [];
      // 终态任务池读完就收起来：不参与唤醒和默认列表，历史仍可按需查
      try { archiveSettledTaskPools(this.store); } catch (e) { this.log.warn(`任务池归档失败：${(e as Error).message}`); }
    }
  }

  private async handleWakeInner(w: Wake): Promise<void> {
    const cfg = this.o.cfg;
    const t0 = this.clock.now();
    const entry: any = {
      ts: new Date(t0).toISOString(), type: w.type, reasons: w.reasons, pools: [...w.pools],
      plans: w.planFires.map((f) => f.planId),
    };
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
    // 三条闸：调用次数、折算 token、**钱**。现在以钱为准（dailyCny），
    // dailyTokens / dailyLlmCalls 配成负数即关掉对应保险丝，只留 10 元/天这条硬线。
    // 钱的口径 = 官方单价表 × 峰谷 × 汇率，命中缓存的那部分只按 hit 价算，
    // 所以「上下文很长但几乎是重读」不再吃掉整个日额度。
    const cnyCap = Number(cfg.limits.dailyCny ?? 0);
    const usdCny = Number(cfg.limits.usdCny ?? 7.1) || 7.1;
    const spentCny = (usage.cost_usd ?? 0) * usdCny;
    if (
      (cfg.limits.dailyLlmCalls >= 0 && usage.llm_calls >= cfg.limits.dailyLlmCalls) ||
      (cfg.limits.dailyTokens >= 0 && usage.tokens >= cfg.limits.dailyTokens) ||
      (cnyCap > 0 && spentCny >= cnyCap)
    ) {
      const notice = await this.notifyCap(day);
      return finish("skipped:daily-cap", notice ? { usage, spentCny, notice } : { usage, spentCny });
    }

    // 任务汇报：task-updated（审批/手动触发）和任务事件 tick 共用同一条链路。
    // 只在有终态任务时转述；没有就照旧走原来的 task 池处理（比如 progress）。
    const isTaskPoolTick = w.type === "tick" && w.pools.size > 0
      && [...w.pools].every((id) => this.store.getPool(id)?.kind === "task");
    if (w.type === "task-updated" || isTaskPoolTick) {
      const setAt = takePendingTick(this.store);
      const cursor = this.relayCursor();
      if (cursor !== null || setAt !== null) {
        const since = cursor === null ? setAt! : (setAt === null ? cursor : Math.min(cursor, setAt));
        if (await this.relayTaskUpdates(since, finish, t0)) return;
      }
      if (w.type === "task-updated") return finish("skipped:no-task-tick");
    }

    // 读池：所有有未读的池（不只是触发的池），一次唤醒合并处理
    const cursorsBefore = new Map(this.store.poolsWithUnread().map((p) => [p, this.store.getCursor(p)]));
    const unread = this.hub.takeUnread();
    this.currentUnread = unread;
    if (!unread.length) return finish("skipped:nothing-new");

    const involved = new Set<string>(unread.map((m) => m.pool_id));
    const context = new Map<string, StoredMessage[]>();
    for (const pid of involved) {
      if (!this.store.getPool(pid)) continue;
      if (!this.engine.seenPools.has(pid)) {
        const firstUnread = unread.find((m) => m.pool_id === pid)?.seq ?? Number.MAX_SAFE_INTEGER;
        context.set(pid, this.store.recentMessages(pid, cfg.context.recentContextMessages, firstUnread - 1));
      }
    }
    // 记忆和别名都不主动注入：她需要时用 memory search / trace 自己查，避免每轮灌一屏陈旧内容。
    const handoff = this.engine.takePendingHandoff();
    entry.handoffIncluded = !!handoff;
    // 话题库已经搬进沙盒（/work/topics），她自己去读，这里不再查库。
    const prompt = wakePrompt(this.store, {
      wake: w, now: t0, unread, context, handoff, topics: [], mainPool: mainPoolId(cfg),
    });
    for (const pid of involved) this.engine.seenPools.add(pid);
    entry.read = unread.map((m) => ({
      pool: m.pool_id,
      seq: m.seq,
      from: m.from_self ? cfg.agent.name : (this.store.userDisplayName(m.platform, m.sender_id) || m.sender_name),
      text: m.text.slice(0, 80),
    }));
    entry.promptChars = prompt.length;

    // 未读里的图 + 之前被 send 顺带消费掉的图，按 seq 去重后取最近 N 张
    const pending = this.hub.takePendingMedia();
    const mediaMsgs = [...new Map([...unread, ...pending].map((m) => [m.seq, m])).values()]
      .sort((a, b) => a.seq - b.seq);
    const picked = pickImageEntries(mediaMsgs, cfg.media.maxImagesInContext);
    const images = picked.map((p) => p.image);
    entry.imageMsgs = mediaMsgs.filter((m) => m.media_type === "image" && m.attachment).length;
    entry.imageCount = images.length;
    if (entry.imageMsgs) this.log.info(`图片：图片消息 ${entry.imageMsgs} 条（未读 ${unread.length} / 待补 ${pending.length}），实际传入 ${entry.imageCount} 张`);
    const imageIndex = picked
      .map((p, i) => `${i + 1}. #${p.seq} 图片#${p.id}`)
      .join("\n");
    const omitted = entry.imageMsgs - images.length;
    const fullPrompt = images.length
      ? `${prompt}\n\n【附带图片】本轮附上 ${images.length} 张图片，按下面的顺序与上文出现的 [图片#id] 一一对应（不要当成同一张）：\n${imageIndex}`
        + (omitted > 0 ? `\n更早的 ${omitted} 张这次没有附上；需要时用 chat action=view path=图片#id 单独读回。` : "")
      : prompt;
    // 这个 session 已经聊掉多少 token：到顶就换个新会话接着聊，
    // 不然上下文越滚越大，每轮都按最贵的那档重发一遍。
    const sessionLimit = cfg.handoff.sessionTokenLimit ?? 0;
    const sessionTokens = sessionLimit > 0 ? this.store.tokensSince(this.store.lastHandoffAt()) : 0;
    const forceHandoff = sessionLimit > 0 && sessionTokens >= sessionLimit;
    if (forceHandoff) entry.sessionTokens = sessionTokens;
    const res = await this.engine.run(fullPrompt, {
      tokensLeft: tokensLeftOf(cfg, usage.tokens),
      callsLeft: callsLeftOf(cfg, usage.llm_calls),
      forceHandoff,
    }, images);
    this.store.addUsage(day, res.llmCalls, res.tokens, 1, this.usageExtra(res));

    const sent = res.toolCalls.filter((c) => isChatCall(c, "send") && !c.isError).map((c) => c.args);
    this.sendsThisTurn = sent.length;
    if (this.silenceReason) entry.silent = this.silenceReason;
    entry.sentCount = sent.length;
    // LLM 出错且什么都没发：回滚游标，下次 tick 重试
    if (res.error && !sent.length) {
      for (const [p, seq] of cursorsBefore) this.store.setCursor(p, seq);
      // 模型/接口报错也是「程序的事」，别让她背锅
      await this.notifySys("error", this.errorText(res.error));
    }
    // 后台只做记忆梳理；技能和业务关系不在这里触发
    this.noteInboundMessages(unread);
    void this.maybeMemoryReview(unread).catch((e) => this.log.warn(`记忆梳理异常：${(e as Error).message}`));
    finish(res.error ? "error" : res.aborted ? `aborted:${res.abortReason}` : "ok", {
      tools: res.toolCalls.map((c) => ({ name: c.name, args: c.args, result: c.result, isError: c.isError })),
      sent, assistantText: res.assistantText, llmCalls: res.llmCalls, tokens: res.tokens,
      // 折算前的原始 token 和 pi 报的美元成本：用来判断缓存到底命中没有
      rawTokens: res.rawTokens, cost: res.cost ? Number(res.cost.toFixed(6)) : undefined,
      contextTokens: res.contextTokens, handoffId: res.handoffId, error: res.error,
    });
  }
}
