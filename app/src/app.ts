/** 组装：Store + Hub + Scheduler + RunQueue + Agent 引擎；处理唤醒。 */
import path from "node:path";
import fs from "node:fs";
import type { Config } from "./config.ts";
import { isChatCall } from "./core/tool-call.ts";
import { Store } from "./core/db.ts";
import { Hub } from "./core/hub.ts";
import { Logger } from "./core/logger.ts";
import { evaluateGate } from "./core/gate.ts";
import { buildReflectionPrompt, parseReflection } from "./core/reflection.ts";
import { RunQueue, makeWake } from "./core/queue.ts";
import {
  appendNote, archiveSettledTaskPools, getTask, listTasks, listTasksUpdatedSince, takePendingTick, markPendingTick,
  taskDisplayName, updateTask, type Task,
} from "./core/tasks.ts";
import { sweepExpirations } from "./core/approvals.ts";
import { isRunnerAlive, startTask, writeTaskDoc, type DispatchDeps } from "./core/dispatch.ts";
import { resolveApiToken } from "./api-token.ts";
import { Scheduler } from "./core/scheduler.ts";
import { realClock, type Clock } from "./core/clock.ts";
import { dayKey, fmtShort } from "./core/time.ts";
import { costUsd } from "./core/pricing.ts";
import { EmojiTable } from "./core/emoji.ts";
import { toImageContent } from "./core/media.ts";
import type { ImagePart } from "./agent/engine.ts";
import type { Attachment } from "./types.ts";
import { PiEngine, type AgentEngine, type RunResult } from "./agent/engine.ts";
import { createTools, type RbExec } from "./agent/tools.ts";
import { ApprovalGate } from "./core/approval.ts";
import { TaskApprovalGate, type TaskApprovalOutcome, type TaskApprovalTarget } from "./core/task-approval.ts";
import { systemPrompt, wakePrompt } from "./agent/prompt.ts";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { StoredMessage, Wake } from "./types.ts";
import { resolvePrimaryPool } from "./core/primary-pool.ts";
import { businessDir, runtimeDir, sharedDir } from "./core/runtime.ts";
import { ensureBusinessSeeded } from "./ops/business-map.ts";
import { render } from "./agent/template.ts";
import {
  effectiveMemoryReviewSettings, loadMemoryReviewState, memoryReviewDue, saveMemoryReviewState,
  type MemoryReviewState,
} from "./ops/memory-review.ts";

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

/** 从消息里挑最近的 N 张图，转成 pi 的 image content；文件读不到就跳过。 */
export function pickImages(msgs: { attachment?: Attachment | null }[], max: number): ImagePart[] {
  const n = Math.max(1, max);
  return msgs.filter((m) => m.attachment).slice(-n)
    .map((m) => toImageContent(m.attachment!))
    .filter((x): x is ImagePart => !!x);
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

/** 读 worker 落在 runtime/shared 的汇报文件；没有就回空串，不打断转述。 */
function readTaskReport(dir: string, id: number): string {
  try {
    return fs.readFileSync(path.join(dir, `task-${id}.md`), "utf8").trim();
  } catch {
    return "";
  }
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
  private clock: Clock;
  /** 当前正在处理的唤醒，工具用它判断这轮是不是主动开口 */
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
      (target, text) => this.hub.sendSystem(target.platform, target.chatId, text),
      {
        onApprove: (task, by) => this.approveTaskFromChat(task, by),
        onReject: (task, by) => this.rejectTaskFromChat(task, by),
        onTimeout: (task) => this.timeoutTaskFromChat(task),
      },
    );
    // 两个闸门可以共用一个审批房：先看是不是任务审批，再看是不是命令审批。
    // 只有闸门明确认领的裁决消息才不进池；其余消息照常入池。
    // 审批房也可能是私聊，不能因为聊天 id 命中审批配置就把正常对话吞掉。
    this.hub.approval = {
      tryHandle: (m) => this.taskApproval.tryHandle(m) || this.approval.tryHandle(m),
    };
    this.scheduler = new Scheduler(cfg.scheduler, {
      clock: this.clock, queue: this.queue, isPaused: () => this.store.isPaused(),
      poolsWithUnread: () => this.store.poolsWithUnread(),
      poolKind: (id) => this.store.getPool(id)?.kind,
      proactivePools: (now) => this.proactivePools(now),
      log: (m) => this.log.info(`[sched] ${m}`), warn: (m) => this.log.warn(`[sched] ${m}`),
    });
    this.hub.scheduler = this.scheduler;
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
  }

  async start() {
    await this.hub.startAdapters();
    this.scheduler.start();
    this.startReflectionLoop();
    this.startApprovalSweep();
    this.recoverPendingTaskApprovals();
    this.log.info(`rabbit-bot 已启动 tick=${this.o.cfg.scheduler.tickMs}ms taskTick=${this.o.cfg.scheduler.taskTickMs}ms privateWake=${this.o.cfg.scheduler.privateWakeMs}ms debounce=${this.o.cfg.scheduler.debounceMs}ms 消息tick批=${this.o.cfg.scheduler.batchToTick ? "on" : "off"} 缓存折算=${this.o.cfg.limits.cacheReadRate} 换会话=${this.o.cfg.handoff.sessionTokenLimit}tok 日额度=${this.o.cfg.limits.dailyTokens}tok 日花费上限=¥${this.o.cfg.limits.dailyCny ?? 0} 汇率=${this.o.cfg.limits.usdCny ?? 7.1} paused=${this.store.isPaused()}`);
  }

  async stop() {
    this.scheduler.stop();
    if (this.reflectionTimer) { clearInterval(this.reflectionTimer as any); this.reflectionTimer = null; }
    if (this.approvalSweepTimer) { clearInterval(this.approvalSweepTimer as any); this.approvalSweepTimer = null; }
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
    // 群聊比私聊克制得多：门槛更高、间隔更长、一天更少（字段在 config.proactive.group）
    const { group: groupOverride, ...baseGate } = cfg.proactive ?? ({} as typeof cfg.proactive);
    const gateFor = (kind: string) =>
      kind === "group" ? { ...baseGate, ...(groupOverride ?? {}) } : baseGate;

    for (const pool of this.store.listPools()) {
      // 任务池是任务事件的落点，不是她跟人说话的地方：不主动、不自省
      if (pool.kind === "task") continue;
      if (!this.platformLive(pool.platform)) continue;
      const pid = pool.pool_id;
      const r = this.store.latestReflection(pid);
      const urgency = r ? Number(r.urgency) : null;
      // 连说没人回：用户最后一条之后，她主动说了几次。不用存计数器，从库里数出来
      const consecutive = globalLast > 0
        ? this.store.countProactiveSpeaks(globalLast, now + 1, pid)
        : 0;

      const v = evaluateGate({
        now,
        urgency,
        lastUserTs: globalLast,
        poolLastUserTs: this.store.lastUserMessageTs(pid),
        // 冷却锚点用「上次尝试」而不是「上次真发」：醒了又忍住不说的那轮也得冷静一下
        lastSpeakTs: this.store.lastProactiveAttemptTs(pid),
        speaksToday: this.store.countProactiveSpeaks(dayStart, dayEnd, pid),
        consecutiveSpeaks: consecutive,
        chatStreaming: this.queue.isBusy(),
        tz: cfg.timezone,
        cfg: gateFor(pool.kind),
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

  // ---------- 任务发布审批 ----------

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
   * target=origin：优先发到任务发起时所在的那个聊天；
   * 找不到（例如 API/技能建任务没带池）再退回固定审批房。
   */
  private resolveTaskApprovalTarget(task: Task): TaskApprovalTarget | null {
    const ta = this.o.cfg.taskApproval;
    if ((ta.target ?? "origin") === "origin") {
      const pool = task.pool_id ? this.store.getPool(task.pool_id) : null;
      if (pool && pool.platform !== "task" && pool.external_id) {
        return { platform: pool.platform, chatId: pool.external_id };
      }
    }
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
        const target = this.resolveTaskApprovalTarget(task);
        void this.timeoutTaskFromChat(task).then((out) => {
          if (out.text && this.o.cfg.taskApproval.notify !== false && target) {
            void this.hub.sendSystem(target.platform, target.chatId, out.text);
          }
        });
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
    appendNote(this.store, current.id, `飞书审批通过（by=${by}）`);
    try {
      const deps = this.taskDispatchDeps();
      writeTaskDoc(this.store, current, {
        apiBase: deps.apiBase, sharedDir: deps.sharedDir, businessDir: deps.businessDir,
      });
      await startTask(this.store, getTask(this.store, current.id)!, deps);
      return { ok: true, text: `#${current.id}「${taskDisplayName(current)}」已批准，开始执行` };
    } catch (e) {
      const message = (e as Error).message;
      const fresh = getTask(this.store, current.id);
      if (!fresh || !isRunnerAlive(fresh.runner_pid)) {
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
    return { ok: true, text: `#${current.id}「${taskDisplayName(current)}」已拒绝，没有执行` };
  }

  /** 超时 = 拒绝（fail-closed）；任务已经不在待审状态就不回消息。 */
  private async timeoutTaskFromChat(task: Task): Promise<TaskApprovalOutcome> {
    const current = getTask(this.store, task.id);
    if (!current || current.status !== "pending_approval") return { ok: false };
    updateTask(this.store, current.id, { status: "cancelled" });
    appendNote(this.store, current.id, "审批超时，按拒绝处理，未执行");
    return { ok: false, text: `#${current.id}「${taskDisplayName(current)}」审批超时，按拒绝处理，没有执行` };
  }

  // ---------- 后台记忆梳理 ----------

  /** 每轮唤醒后累加用户回合；到点由 maybeMemoryReview 决定跑不跑。 */
  private noteInboundMessages(unread: StoredMessage[]): void {
    const inbound = unread.filter((m) => !m.from_self).length;
    if (!inbound) return;
    this.memoryReviewState = { ...this.memoryReviewState, turns: this.memoryReviewState.turns + inbound };
    try { saveMemoryReviewState(this.o.cfg, this.memoryReviewState); } catch { /* 状态写失败不影响唤醒 */ }
  }

  private pickReviewPool(unread: StoredMessage[]): string | null {
    const inbound = unread.filter((m) => !m.from_self && m.user_id);
    if (inbound.length) return inbound[inbound.length - 1].pool_id;
    return resolvePrimaryPool(this.store, this.activeWake) ?? null;
  }

  /**
   * 后台记忆梳理：到点就 fork 一个只带 memory 的临时会话。
   * 技能和业务关系都不在这里做——它们走主动（ufa-maintenance 技能）。
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
        `${fmtShort(m.ts)} ${m.from_self ? cfg.agent.name : (m.sender_name || m.user_id || "对方")}：${m.text.slice(0, 300)}`,
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

  /**
   * 平台适配器关掉了（例如把飞书 app 让给别人），它的历史池还留在库里给人查，
   * 但自省和主动不该再为它跑——那只是白白烧 token、还把「没人回」当成她自己的问题。
   */
  private platformLive(platform: string): boolean {
    const a = (this.o.cfg.adapters as unknown as Record<string, { enabled?: boolean }> | undefined)?.[platform];
    return a ? a.enabled !== false : true;
  }

  /** 挑一个「该想一想了」的池，跑一次自省。一次只做一个，省额度也避免打堆 */
  private async reflectDue(): Promise<void> {
    if (this.reflectionBusy || this.store.isPaused()) return;
    const cfg = this.o.cfg;
    const now = this.clock.now();
    const delay = cfg.proactive?.reflectionDelayMs ?? 300_000;
    for (const pool of this.store.listPools()) {
      // 任务池的进度/完成事件不该触发「她想说话了」
      if (pool.kind === "task") continue;
      if (!this.platformLive(pool.platform)) continue;
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

  private async runReflection(poolId: string, now: number): Promise<void> {
    const cfg = this.o.cfg;
    const day = dayKey(now, cfg.timezone);
    const usage = this.store.getUsage(day);
    const tokensLeft = tokensLeftOf(cfg, usage.tokens);
    // 自省是「想一想」，不是干活。额度见底就别想了，把额度留给真正的对话
    if (tokensLeft < 2000 || cfg.limits.dailyLlmCalls >= 0 && usage.llm_calls >= cfg.limits.dailyLlmCalls) return;

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
      { tokensLeft, callsLeft: callsLeftOf(cfg, usage.llm_calls) },
      `你正在独处。只做一件事：想清楚此刻心里在想什么、有多想开口。只输出 JSON，不要任何别的内容。`,
    );
    this.store.addUsage(day, res.llmCalls, res.tokens, 0, this.usageExtra(res));

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
    const waiting = this.store.poolsWithUnread()
      .filter((id) => this.store.getPool(id)?.kind !== "task");
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
      .filter((id) => this.store.getPool(id)?.kind !== "task");
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

    const lines: string[] = [
      "【任务汇报】下面这些任务刚刚结束，挑值得说的转述给对应的人。",
      "规则：只转述 done/failed/blocked；每个池只 send 一条，多个任务合并；最多列 10 个，其余写「还有 N 个」。",
      "不要复述汇报全文，不要提 token；这一批都不值得说就 skip。pool 原样用下面给出的别名。",
      "",
    ];
    for (const [pid, list] of byPool) {
      const pool = this.store.getPool(pid);
      const alias = this.store.poolAlias(pid);
      lines.push(`- 池 ${alias}${pool ? `「${pool.title}」` : ""}（${list.length} 个任务）`);
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
    const proactive = w.proactive ?? [];
    if (!unread.length && !proactive.length) return finish("skipped:nothing-new");

    const involved = new Set<string>([
      ...unread.map((m) => m.pool_id),
      ...proactive.map((x) => x.pool).filter((x): x is string => !!x),
    ]);
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
    const prompt = wakePrompt(this.store, { wake: w, now: t0, unread, context, handoff, topics: [] });
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
      tokensLeft: tokensLeftOf(cfg, usage.tokens),
      callsLeft: callsLeftOf(cfg, usage.llm_calls),
      forceHandoff,
    }, images);
    this.store.addUsage(day, res.llmCalls, res.tokens, 1, this.usageExtra(res));

    const sent = res.toolCalls.filter((c) => isChatCall(c, "send") && !c.isError).map((c) => c.args);
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
    // 后台只做记忆梳理；技能和业务关系走主动，不在这里触发
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
