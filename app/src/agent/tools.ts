/** Agent 的自定义工具（pi customTools）。send 是唯一的输出通道。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import type { Hub } from "../core/hub.ts";
import type { StoredMessage } from "../types.ts";
import { fmtGrouped } from "./prompt.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveImage, toImageContent } from "../core/media.ts";
import { resolveImagePath } from "../ops/images.ts";
import { shellRunnerOptions, readSandboxFile, writeSandboxFile, execShell, shellTimeoutSec } from "../ops/exec.ts";
import { runSandboxArgv } from "../core/shell-runner.ts";
import { businessDir, filesDir, sharedDir } from "../core/runtime.ts";
import { hostReadAllowed, rememberHostReadRoot } from "../core/host-read.ts";
import { coerciveHit, coerciveFeedback } from "../core/guard.ts";
import { checkStyle } from "../core/style-gate.ts";
import { classify } from "../core/cmd-rules.ts";
import type { ApprovalGate } from "../core/approval.ts";
import type { TaskApprovalGate } from "../core/task-approval.ts";
import {
  APPROVAL_STATUSES, decideApproval, getApproval, isApprovalStatus, listApprovals,
} from "../core/approvals.ts";
import { addMemory, closeMemory, searchMemories, traceMemory, updateMemory } from "../ops/memories.ts";
import { addKnowledge, archiveKnowledge, getKnowledge, searchKnowledge, updateKnowledge } from "../ops/knowledge.ts";
import { archivePool, listPools, readPool, searchPool } from "../ops/pools.ts";
import { createSchedule, formatSchedule, isScheduleStatus, type ScheduleInput } from "../core/schedules.ts";
import {
  TASK_STATUSES, appendNote, cancelTask, createTask, getTask, isTaskStatus, taskDisplayName, updateTask,
} from "../core/tasks.ts";
import { listTaskEvents } from "../core/task-events.ts";
import {
  DEFAULT_CAPTURE_MS, isRunnerAlive, resumeTask, stopTask,
  type DispatchDeps,
} from "../core/dispatch.ts";
import { resolveApiToken } from "../api-token.ts";
import { formatTask, getTaskView, listTaskViews } from "../ops/tasks.ts";
import { findPaths, formatPath, impactOf, loadBusinessMap, renderIndex, resolveObjects, showObject } from "../ops/business-map.ts";
import { lintBusinessMap } from "../ops/business-lint.ts";

export type RbExec = (argv: string[]) => Promise<{ ok: boolean; code: number; output: string }>;

export interface ToolDeps {
  store: Store;
  hub: Hub;
  cfg: Config;
  now: () => number;
  /** 本轮唤醒类型；主动消息（plan）要过情感绑架护栏 */
  currentWake?: () => { type: string } | null;
  /** 本轮决定不回时的理由（chat action=skip）；非空就是已决定不回 */
  silenceReason?: () => string | null;
  /** 测试注入：用进程内实现替代沙盒 rb（生产走 docker）。 */
  rbExec?: RbExec;
  markSilent?: (reason: string) => void;
  /** 这一轮的主要池：记记忆/加计划时自动落到这里，模型不用自己填池 */
  primaryPool?: () => string | null;
  /** 本轮读进来的未读消息：记记忆时自动绑来源 seq，之后能回查到原文 */
  currentUnread?: () => StoredMessage[];
  /** 宿主机命令审批闸门（只在 exec.shell.mode=host 时被用到） */
  approval?: ApprovalGate;
  /** 任务发布审批闸门：建完任务发审批提示（原聊天或审批房）；没开就回退 Web 任务页 */
  taskApproval?: Pick<TaskApprovalGate, "enabled" | "notify">;
  /** 审批裁决后置位 pending tick 时喊一声（UFA 工具用） */
  enqueue?: () => void;
  /** 日程新建/取消后叫调度器马上重查 */
  scheduleChanged?: () => void;
  /** 工具集归属：必填，避免漏传时回退到全量工具 */
  profile: "ufa" | "wa" | "review";
  /** read_file 的根目录覆盖；UFA 固定为 runtime，传了就不跟着 exec.dir 漂 */
  readRoot?: string;
  /** 任务派发依赖（测试注入假执行器）；默认从 cfg.api + data/run/api.token 组出来 */
  dispatch?: DispatchDeps;
}

/** UFA 进程和回环 API 同机：默认走 127.0.0.1，token 取 data/run/api.token。 */
function defaultDispatchDeps(cfg: Config): DispatchDeps {
  return {
    apiBase: `http://127.0.0.1:${cfg.api?.port ?? 3738}`,
    token: resolveApiToken(cfg),
    dataDir: cfg.dataDir,
    sharedDir: sharedDir(cfg),
    businessDir: businessDir(cfg),
    captureMs: DEFAULT_CAPTURE_MS,
  };
}

const txt = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });

/** 记忆列表的显示格式：带上 #id 和有效期，她才知道改哪条 */
function fmtMemories(list: { id: number; kind: string; content: string; from: number; to: number | null; replaced_by: number | null; source?: { from: number; to: number } | null }[]): string {
  if (!list.length) return "（没有匹配的记忆）";
  const day = (ts: number) => new Date(ts).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  return list
    .map((m) => `#${m.id} [${m.kind}] ${m.content}`
      + (m.to ? `（${day(m.from)} 起，${day(m.to)} 已失效${m.replaced_by ? `，被 #${m.replaced_by} 顶掉` : ""}）` : "")
      + (m.source ? `（来源 #${m.source.from}${m.source.to !== m.source.from ? `-${m.source.to}` : ""}）` : ""))
    .join("\n");
}

/** 把 "a 'b c' d" 切成 ["a", "b c", "d"]：rb 的 args 是一条命令行字符串 */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function createTools(d: ToolDeps) {
  /**
   * 说话这一件事收成一个工具：action=send / skip / view / list / search / help。
   *
   * send 和 skip 必须成对出现——没有 skip，模型只能用「什么都不调用」表达沉默，
   * 而它倾向于拿发一条消息收尾。两个动作放在同一个入口里，沉默才是一个显式决定。
   * list / search 是翻历史，view 是把图片读进上下文。
   */
  const viewCacheDir = path.join(d.cfg.dataDir, "cache");

  const CHAT_HELP = [
    "chat 的用法（action 必填）：",
    "  send    pool content            发一条消息（唯一会被他看到的输出）",
    "  skip    reason                   这一轮不回，什么都不发",
    "  view    path                     把一张图读进上下文（图片#id 或 media/… / inbox/…）",
    "  download id                     按需下载收到的文件（消息里的 附件id=file_xxx）",
    "  list    archived?                看有哪些池（archived=true 连归档池一起列）",
    "  search  q? pool? only? limit?    q 给了就按关键词翻原话；不给 q 就读这个池最近的消息",
    "  archive pool                     归档一个池：默认列表和唤醒里不再出现，历史仍可 search",
    "  unarchive pool                   解档",
    "  help                             看这份说明",
  ].join("\n");

  const chat = defineTool({
    name: "chat",
    label: "chat",
    executionMode: "sequential",
    description:
      "跟他说话，以及翻聊天记录。action 决定做什么："
      + "send（发一条，pool + content，唯一会被他看到的输出）/ skip（这一轮不回，reason 写为什么）/ "
      + "view（把一张图读进上下文，path 用图片#id 或 img 清单里的名字）/ download（按需下载收到的文件，id 用消息里的 附件id=file_xxx）/ "
      + "list（有哪些池，archived=true 连归档池）/ search（按关键词翻原话，不给 q 就读最近的消息）/ "
      + "archive（归档池：默认列表和唤醒里不再出现，历史仍可 search）/ unarchive（解档）/ help。"
      + "该说话的时候一定要 send——只调用别的工具等于这轮什么都没说。"
      + "明确不用回的时候用 skip，别用「什么都不调用」来表达沉默。",
    parameters: Type.Object({
      action: Type.String({ description: "send / skip / view / download / list / search / archive / unarchive / help" }),
      pool: Type.Optional(Type.String({ description: "send、search、archive、unarchive 用：池别名，如 p1" })),
      content: Type.Optional(Type.String({ description: "send 用：一条短消息；表情包写 [emoji:中文id]" })),
      reason: Type.Optional(Type.String({ description: "skip 用：一句话，为什么这一轮不用回（会记进日志）" })),
      path: Type.Optional(Type.String({ description: "view 用：图片#id 或 media/… / inbox/… 开头的文件名" })),
      id: Type.Optional(Type.String({ description: "download 用：消息里的附件 id（file_xxx）" })),
      q: Type.Optional(Type.String({ description: "search 用：关键词，至少两个字" })),
      only: Type.Optional(Type.String({ description: "search 用：self 只看自己说的 / other 只看看他说的" })),
      limit: Type.Optional(Type.Number({ description: "search 用：条数，默认 20" })),
      before_seq: Type.Optional(Type.Number({ description: "search 不给 q 时翻页：读这个 seq 之前的" })),
      archived: Type.Optional(Type.Boolean({ description: "list 用：true 时连已归档的池一起列" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        switch (action) {
          case "help":
            return txt(CHAT_HELP, { ok: true });

          case "skip": {
            if (!p.reason) return txt("skip 要 reason：一句话，为什么这一轮不用回。", { ok: false });
            d.markSilent?.(p.reason);
            return txt(`已标记：这一轮不回（${p.reason}）。什么都不用再做了，结束这一轮。`, { ok: true, silent: true });
          }

          case "send": {
            if (!p.pool || !p.content) return txt("send 要 pool 和 content。", { ok: false });
            // 只有主动开口（plan 到点）才拦：日常对话里「你怎么还不回来」可能是玩笑
            if (d.currentWake?.()?.type === "plan") {
              const why = coerciveHit(p.content);
              if (why) return txt(coerciveFeedback(why), { ok: false, blocked: "coercive" });
            }
            // 风格闸：客服腔、七天内的原样重复，提示词管不住，只有代码管得住（拦下来让她重写）
            const poolRow = d.store.resolvePool(p.pool);
            if (poolRow) {
              const recentSelf = d.store.messagesForReflection(poolRow.pool_id, 60)
                .filter((m) => m.from_self)
                .map((m) => ({ text: m.text, ts: m.ts }));
              const v = checkStyle({ text: p.content, recentSelf, maxChars: d.cfg.send.maxChars });
              if (!v.ok) return txt(v.hint ?? "这句别发，换你自己的说法。", { ok: false, blocked: v.reason });
            }
            const r = await d.hub.send(p.pool, p.content);
            // 被压住：他在这几秒里又说话了。先把新消息给她看，那句原样退回——发不发、怎么改，她重新定
            if (r.held) {
              return txt(
                `先别发，这句给你压住了：「${r.heldText ?? ""}」\n`
                + `因为你说这话的时候他刚好又发来消息：\n${fmtGrouped(d.store, r.newMessages)}\n`
                + "先看他新说了什么，再决定原来那句还要不要发、要不要改。别当没看见照样发。",
                { ok: false, held: true, newCount: r.newMessages.length },
              );
            }
            if (!r.ok) return txt(`发送失败：${r.error}${r.newMessages.length ? `\n新消息：\n${fmtGrouped(d.store, r.newMessages)}` : ""}`, { ok: false });
            const unconfirmed = r.sentParts.filter((x) => !x.confirmed).length;
            const head = unconfirmed ? `已发送，但有 ${unconfirmed} 段暂未确认出现在聊天里` : "已发送并确认";
            const tail = r.newMessages.length ? `\n期间新消息：\n${fmtGrouped(d.store, r.newMessages)}` : "\n期间无新消息";
            return txt(head + tail, { ok: true, newCount: r.newMessages.length });
          }

          case "view": {
            if (!p.path) return txt("view 要 path（media/… 或 inbox/…）。", { ok: false });
            let abs: string;
            try {
              abs = resolveImagePath(d.cfg.dataDir, p.path);
            } catch {
              return txt(`没有这张图：${p.path}（先用 rb img-list 看看有哪些）`, { ok: false });
            }
            try {
              const a = saveImage(fs.readFileSync(abs), { dir: viewCacheDir, maxEdge: d.cfg.media.maxEdge, maxBytes: d.cfg.media.maxBytes }, `view-${path.basename(abs)}`);
              const c = toImageContent(a);
              if (!c) return txt("这张图打不开（不是图片或格式不支持）", { ok: false });
              return { content: [{ type: "image" as const, data: c.data, mimeType: c.mimeType }, { type: "text" as const, text: `已加载 ${p.path}（${a.width}×${a.height}）` }], details: { ok: true } };
            } catch (e) {
              return txt(`读图失败：${(e as Error).message}`, { ok: false });
            }
          }

          case "download": {
            if (!p.id) return txt("download 要 id（消息里写的 附件id=file_xxx）。", { ok: false });
            const r = await d.hub.downloadAttachment(p.id);
            if (!r.ok) return txt(`下载失败：${r.error}`, { ok: false });
            const abs = r.path!;
            const shown = abs.startsWith(filesDir(d.cfg) + path.sep)
              ? path.join("files", path.relative(filesDir(d.cfg), abs))
              : abs;
            return txt(
              `已下载「${r.name ?? path.basename(abs)}」到 ${shown}（${r.bytes ?? 0}B）。用 read_file 打开，或 terminal 处理。`,
              { ok: true, path: shown, id: p.id },
            );
          }

          case "list": {
            const pools = listPools(d.store, { includeArchived: !!p.archived });
            if (!pools.length) return txt("（还没有任何池）", { ok: true, count: 0 });
            const kindLabel = (k: string) => k === "group" ? "群" : k === "task" ? "任务" : k === "private" ? "私聊" : k;
            const lines = pools.map((x: any) => `[${x.alias}]${x.archived ? "[已归档]" : ""} ${kindLabel(x.kind)} ${x.title}　最后 ${x.last_msg_local ?? "—"}　共 ${x.total} 条`);
            return txt(lines.join("\n"), { ok: true, count: pools.length });
          }

          case "archive":
          case "unarchive": {
            if (!p.pool) return txt(`${action} 要 pool。`, { ok: false });
            const r = archivePool(d.store, p.pool, action === "archive");
            return txt(
              `已${action === "archive" ? "归档" : "解档"}池 ${r.pool}（${r.pool_id}）。`
              + (action === "archive" ? "默认列表和唤醒里不再出现，翻历史仍能 search。" : ""),
              { ok: true, pool: r.pool, archived: r.archived },
            );
          }

          case "search": {
            // 不指定池就是这一轮正在说话的那个
            const ref = p.pool ?? (d.primaryPool?.() ?? undefined);
            if (p.q) {
              const r: any = searchPool(d.store, p.q, ref, p.limit, (p.only as any) ?? undefined);
              if (!r.hits) return txt(`没搜到「${p.q}」（池 ${r.pool}${r.only !== "both" ? `，只看${r.only === "self" ? "自己" : "他"}说的` : ""}）。换个词或者放宽 only 再试。`, { ok: true, hits: 0 });
              const body = r.messages.map((m: any) => `[${m.seq}] ${m.local} ${m.from_self ? "我" : m.sender}：${m.text}`).join("\n");
              return txt(`${body}${r.truncated ? `\n（${r.hint}）` : ""}`, { ok: true, hits: r.hits, truncated: !!r.truncated });
            }
            const r: any = readPool(d.store, ref, { limit: p.limit, beforeSeq: p.before_seq });
            const body = r.messages.map((m: any) => `[${m.seq}] ${m.local} ${m.from_self ? "我" : m.sender}：${m.text}`).join("\n");
            return txt(`池 ${r.pool}（共 ${r.total} 条）\n${body || "（还没有消息）"}`, { ok: true, count: r.messages.length });
          }

          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${CHAT_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`没成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  /**
   * 记忆：一个工具，action 分六件事。
   *
   * 为什么不做成六个工具：它们共用同一套参数（id / content / 时间），拆开就是六份 schema、
   * 六次「她该点哪个」的判断。二级入口把成本摊到一次，代价是 action 写错要重来——
   * 所以每个 action 的必填项在描述里逐条写清，出错时把可选项原样回给她。
   *
   * 为什么记忆该走工具而不是 `rb mem-add --content "…"`：记忆内容是自由文本，
   * 穿过 shell 要过引号、全角符号、箭头、换行，少一个转义就静默写坏一条——
   * 写坏的记忆没人看得见，不像消息发错了立刻能发现。
   */
  const poolOf = (): string => {
    const p = d.primaryPool?.();
    if (!p) throw new Error("这一轮没有对应的池");
    return p;
  };
  const userOf = (override?: string): string => {
    if (override) return override;
    const uid = d.store.lastUserId(poolOf());
    if (!uid) throw new Error("这个池里还没有对方的消息，拿不到 user_id");
    return uid;
  };
  /** 这一轮他说的消息 seq 区间；没有就返回空，让记忆留成无来源而不是硬绑 */
  const wakeSeqRange = (user: string, pool: string): { from?: number; to?: number } => {
    const seqs = (d.currentUnread?.() ?? [])
      .filter((m) => m.pool_id === pool && m.user_id === user && !m.from_self)
      .map((m) => m.seq)
      .sort((a, b) => a - b);
    return seqs.length ? { from: seqs[0], to: seqs[seqs.length - 1] } : {};
  };

  const MEMORY_HELP = [
    "memory 的用法（action 必填）：",
    "  recent  [limit]                          最近记下的（默认 20 条，只给还生效的）",
    "  search  q? at? all? limit?               按关键词翻，all=1 连失效的也翻",
    "  add     content kind? supersede? from? until? source_seq?   记一条",
    "  trace   id before? after?                回看这条记忆的来源消息和前后文",
    "  expire  id                               这条不再成立了，关掉（不写新的）",
    "  update  id content? from?                就地订正正文/起始时间，不动时间线",
    "  help                                     看这份说明",
    "",
    "只记对方明说过的具体事实，不记推断和总结。说变了的事用 add + supersede 顶掉旧的；",
    "事实没变只是不再成立（「他这周在出差」回来了）用 expire。",
    "正文要能单独看懂：群里、或被记的不是当前说话人时，写清名字（「小王搬家」），别只写「他」；",
    "被记的是别人时，把 user 填成那个人。",
    "add 默认把来源绑到这一轮他说的消息上；引用更早的某句时，把那条消息的 #seq 填进 source_seq。",
  ].join("\n");

  const memory = defineTool({
    name: "memory",
    label: "memory",
    executionMode: "sequential",
    description:
      "长期记忆。记忆不会自动注入——指代不清、要引用旧事时先查，别猜。action 决定做什么："
      + "recent（最近记下的）/ search（按关键词翻，all=1 连失效的）/ "
      + "add（记一条）/ trace（回看来源消息和前后文）/ expire（不再成立，关掉）/ update（就地订正）/ help。"
      + "记的是对方明说过的具体事实，不是你的推断。他说变了的事，add 时把旧条目的 #id 填进 supersede；"
      + "没有新事实、只是不再成立，用 expire。别名也走 add：kind=alias，content 写「那个项目 → 电商 AI Agent」。"
      + "拿不准就先 memory action=help。",
    parameters: Type.Object({
      action: Type.String({ description: "recent / search / add / trace / expire / update / help" }),
      id: Type.Optional(Type.Number({ description: "trace、expire、update 用：记忆 id（提示词里记忆前的 #号）" })),
      content: Type.Optional(Type.String({ description: "add、update 用：正文，带日期更好；群里写清是谁，别只写「他」" })),
      kind: Type.Optional(Type.String({ description: "add 用：fact（默认）/ plan / alias / topic" })),
      supersede: Type.Optional(Type.Number({ description: "add 用：被这条顶掉的旧记忆 id" })),
      from: Type.Optional(Type.String({ description: "add、update 用：从什么时候起成立，ISO" })),
      until: Type.Optional(Type.String({ description: "add 用：到期时间，ISO" })),
      q: Type.Optional(Type.String({ description: "search 用：关键词" })),
      at: Type.Optional(Type.String({ description: "search 用：查那一刻有效，ISO" })),
      all: Type.Optional(Type.Boolean({ description: "search 用：连失效的一起给" })),
      limit: Type.Optional(Type.Number({ description: "recent、search 用：条数，默认 20" })),
      source_seq: Type.Optional(Type.Number({ description: "add 用：来源消息的 #seq（引用更早某句时填；不填就绑本轮他的话）" })),
      before: Type.Optional(Type.Number({ description: "trace 用：来源往前看几条，默认 5" })),
      after: Type.Optional(Type.Number({ description: "trace 用：来源往后看几条，默认 5" })),
      user: Type.Optional(Type.String({ description: "一般不用填，默认是当前对话的人" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        switch (action) {
          case "help":
            return txt(MEMORY_HELP, { ok: true });
          case "recent": {
            const list = searchMemories(d.store, { user: userOf(p.user), pool: poolOf(), limit: p.limit });
            return txt(fmtMemories(list), { ok: true, count: list.length });
          }
          case "search": {
            const list = searchMemories(d.store, {
              user: userOf(p.user), pool: poolOf(), limit: p.limit, q: p.q, at: p.at, all: p.all,
            });
            return txt(fmtMemories(list), { ok: true, count: list.length });
          }
          case "add": {
            if (!p.content) return txt("add 要 content（记什么）。用 memory action=help 看说明。", { ok: false });
            const user = userOf(p.user);
            const pool = poolOf();
            // 显式 source_seq 优先（引用更早的某句）；否则绑到这一轮他说的消息上
            const bound = wakeSeqRange(user, pool);
            const r = addMemory(d.store, {
              user, content: p.content, pool, kind: p.kind,
              from: p.from, until: p.until, supersede: p.supersede,
              source_seq: p.source_seq ?? bound.from,
              source_seq_end: p.source_seq ?? bound.to,
            });
            return txt(
              (r.superseded ? `记下了（#${r.id}），原来 #${r.superseded} 那条已经失效。` : `记下了（#${r.id}）。`)
              + (r.source ? ` 来源 #${r.source.from}${r.source.to !== r.source.from ? `-${r.source.to}` : ""}，要回看用 trace。` : ""),
              { ok: true, id: r.id, source: r.source },
            );
          }
          case "trace": {
            if (p.id === undefined) return txt("trace 要 id（提示词里记忆前的 #号）。", { ok: false });
            const r = traceMemory(d.store, { user: userOf(p.user), id: p.id, before: p.before, after: p.after });
            if (!r.source) return txt(r.note ?? "这条记忆没有来源消息。", { ok: true, id: r.id });
            const body = r.messages.map((m) => `${m.anchor ? "→" : " "} #${m.seq} ${m.local} ${m.from_self ? "我" : m.sender}：${m.text}`).join("\n");
            return txt(`记忆 #${r.id}（${r.content}）\n来源 #${r.source.from}${r.source.to !== r.source.from ? `-${r.source.to}` : ""} · ${r.source.pool}\n${body || "（找不到消息）"}`, { ok: true, id: r.id, source: r.source });
          }
          case "expire": {
            if (p.id === undefined) return txt("expire 要 id（提示词里记忆前的 #号）。", { ok: false });
            const r = closeMemory(d.store, { user: userOf(p.user), id: p.id });
            return txt(r.already ? `#${p.id} 早就失效了，没动它。` : `#${p.id} 关掉了。`, { ok: true });
          }
          case "update": {
            if (p.id === undefined) return txt("update 要 id。", { ok: false });
            const r = updateMemory(d.store, { user: userOf(p.user), id: p.id, content: p.content, from: p.from });
            return txt(`#${r.id} 改好了：${r.content}`, { ok: true });
          }
          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${MEMORY_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`没成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  /**
   * 知识库：跨会话可复用的业务知识，一篇一条。
   * 比写文件快：一次 add 就落库，不建任务、不选目录、能按关键词/标签查回来。
   */
  const KNOWLEDGE_HELP = [
    "knowledge 的用法（action 必填）：",
    "  add     title body tags? object_id?        记一篇可复用的业务知识",
    "  get     id                                 看全文",
    "  search  q? tag? limit? all?                按关键词/标签查，all=1 连归档的也查",
    "  list    limit?                             最近的知识",
    "  update  id title? body? tags? object_id?   就地改",
    "  archive id                                 归档（不再出现在默认搜索里）",
    "  help                                       看这份说明",
    "",
    "和记忆的区别：知识是能反复查的正文（流程、口径、排障、设计判断）；",
    "记忆是「谁在什么时候说过什么」的单条事实。对象和关系用 map。",
  ].join("\n");

  const fmtKnowledge = (list: any[]): string => {
    if (!list.length) return "（没有匹配的知识）";
    return list.map((k) => {
      const tags = k.tags?.length ? ` [${k.tags.join(", ")}]` : "";
      const body = String(k.body ?? "").replace(/\s+/g, " ").slice(0, 120);
      return `#${k.id}${tags} ${k.title}\n  ${body}${body.length >= 120 ? "…" : ""}`;
    }).join("\n");
  };

  const knowledge = defineTool({
    name: "knowledge",
    label: "knowledge",
    executionMode: "sequential",
    description:
      "知识库：跨会话可复用的业务知识，一篇一条。action 决定做什么："
      + "add（title + body，一次记一篇）/ get（看全文）/ search（按 q 或 tag 查）/ "
      + "list（最近的知识）/ update（就地改）/ archive（归档）/ help。"
      + "它比写文件快：不用建任务、不用选目录，记完能直接查回来。"
      + "可复用的流程、口径、排障、设计判断放这里；具体事实放 memory；对象/关系用 map。",
    parameters: Type.Object({
      action: Type.String({ description: "add / get / search / list / update / archive / help" }),
      id: Type.Optional(Type.Number({ description: "get、update、archive 用：知识编号" })),
      title: Type.Optional(Type.String({ description: "add、update 用：这篇知识叫什么" })),
      body: Type.Optional(Type.String({ description: "add、update 用：正文" })),
      tags: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "add、update 用：标签，逗号分隔或数组" })),
      object_id: Type.Optional(Type.String({ description: "add、update 用：关联的业务对象 id（可选）" })),
      q: Type.Optional(Type.String({ description: "search 用：关键词" })),
      tag: Type.Optional(Type.String({ description: "search 用：按标签筛" })),
      limit: Type.Optional(Type.Number({ description: "search、list 用：条数，默认 20" })),
      all: Type.Optional(Type.Boolean({ description: "search 用：连归档的也查" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        switch (action) {
          case "help":
            return txt(KNOWLEDGE_HELP, { ok: true });
          case "add": {
            let pool = "";
            let range: { from?: number; to?: number } = {};
            try {
              pool = poolOf();
              range = wakeSeqRange(userOf(), pool);
            } catch { /* 没有当前池/用户就不绑来源，知识本身仍然可写 */ }
            const r = addKnowledge(d.store, {
              title: p.title, body: p.body, tags: p.tags, object_id: p.object_id,
              pool, source_seq: range.from, source_seq_end: range.to,
            }, d.now());
            return txt(`知识 #${r!.id} 收下了：${r!.title}${r!.tags.length ? ` [${r!.tags.join(", ")}]` : ""}`, { ok: true, id: r!.id });
          }
          case "get": {
            if (p.id === undefined) return txt("get 要 id（知识编号）。", { ok: false });
            const k = getKnowledge(d.store, p.id)!;
            const tags = k.tags.length ? `标签：${k.tags.join(", ")}\n` : "";
            const source = k.source ? `来源：${k.source.pool}${k.source.from ? ` #${k.source.from}${k.source.to !== k.source.from ? `-${k.source.to}` : ""}` : ""}\n` : "";
            return txt(`#${k.id} ${k.title}\n${tags}${source}\n${k.body}`, { ok: true, knowledge: k });
          }
          case "search": {
            const list = searchKnowledge(d.store, { q: p.q, tag: p.tag, limit: p.limit, all: p.all });
            return txt(fmtKnowledge(list), { ok: true, count: list.length, ids: list.map((k) => k.id) });
          }
          case "list": {
            const list = searchKnowledge(d.store, { limit: p.limit });
            return txt(fmtKnowledge(list), { ok: true, count: list.length, ids: list.map((k) => k.id) });
          }
          case "update": {
            const k = updateKnowledge(d.store, {
              id: p.id, title: p.title, body: p.body, tags: p.tags, object_id: p.object_id,
            }, d.now());
            return txt(`知识 #${k!.id} 改好了：${k!.title}`, { ok: true, id: k!.id });
          }
          case "archive": {
            const k = archiveKnowledge(d.store, { id: p.id }, d.now());
            return txt(`知识 #${k!.id} 已归档：${k!.title}`, { ok: true, id: k!.id });
          }
          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${KNOWLEDGE_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`没成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  /**
   * 日程：到点唤醒自己，并把 content 原话带进提示词。
   * 和 plan 分开：plan 是目标看板，不排时间；日程只管「什么时候叫你、叫你做什么」。
   */
  const SCHEDULE_HELP = [
    "schedule 的用法（action 必填）：",
    "  create  content title? cron? delay_minutes?            建日程；content 是到点要带给你自己的话",
    "  list    status?                                      看日程，默认 active；status=all 看全部",
    "  cancel  id                                           取消日程",
    "  help                                                 看这份说明",
    "",
    "cron 是 5 段式（分 时 日 月 周，Asia/Shanghai），例如：0 9 * * * = 每天 9:00；0 9 * * 1 = 每周一 9:00。",
    "也可以写 delay_minutes=30，表示创建后 30 分钟触发一次。",
    "不会百分百准时：到点附近才唤醒；同一轮到点的多条日程会合并成一次唤醒。单条日程的周期不能低于 1 分钟。",
  ].join("\n");

  const schedule = defineTool({
    name: "schedule",
    label: "schedule",
    executionMode: "sequential",
    description:
      "定时日程：到点唤醒自己，并把 content 原话带进提示词。action 决定做什么："
      + "create（必填 content；给 cron 是重复日程，或给 delay_minutes=N 表示 N 分钟后一次；title 可选）/ "
      + "list（默认 active，status=all 看全部）/ cancel（按 id 取消）/ help。"
      + "cron 用 5 段式（分 时 日 月 周，Asia/Shanghai）；每天、每周都用 cron。"
      + "到点事件会写进常驻 schedule 池；只读它，不要往 schedule 池发消息。"
      + "他不要求到点提醒/启动，就别建日程。",
    parameters: Type.Object({
      action: Type.String({ description: "create / list / cancel / help" }),
      id: Type.Optional(Type.Number({ description: "cancel 用：日程 id" })),
      title: Type.Optional(Type.String({ description: "create 用：短标题，不填就用 content 截断" })),
      content: Type.Optional(Type.String({ description: "create 用：到点要带给你自己的原话（提醒什么、做什么）" })),
      cron: Type.Optional(Type.String({ description: "create 用：5 段式 cron，例如 0 9 * * *" })),
      delay_minutes: Type.Optional(Type.Number({ description: "create 用：创建后多少分钟触发一次" })),
      status: Type.Optional(Type.String({ description: "list 用：active / cancelled / done / all" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      const tz = d.cfg.timezone;
      try {
        switch (action) {
          case "help":
            return txt(SCHEDULE_HELP, { ok: true });
          case "create": {
            const input: ScheduleInput = {
              title: p.title,
              content: p.content,
              cron: p.cron,
              delay_minutes: p.delay_minutes,
            };
            if (!String(p.content ?? "").trim()) return txt("create 要 content：到点要带给你自己的话。", { ok: false });
            if (!String(p.cron ?? "").trim() && p.delay_minutes === undefined) {
              return txt("create 要给 cron（重复）或 delay_minutes（N 分钟后一次）。", { ok: false });
            }
            const created = createSchedule(d.store, input, d.now(), tz);
            d.scheduleChanged?.();
            const f = formatSchedule(created, tz);
            return txt(`日程 #${f.id}「${f.title}」建好了，下次 ${f.next_at_local}。`, { ok: true, schedule: f });
          }
          case "list": {
            const want = String(p.status ?? "active").trim().toLowerCase();
            const status = want === "all" ? undefined : (isScheduleStatus(want) ? want : null);
            if (status === null) return txt(`status 只能是 active / cancelled / done / all。`, { ok: false });
            const list = d.store.listSchedules(status);
            if (!list.length) return txt("没有日程。", { ok: true, count: 0 });
            const text = list.map((s) => {
              const f = formatSchedule(s, tz);
              const when = s.kind === "cron" ? `cron ${s.cron}` : `创建后 ${s.delay_minutes} 分钟`;
              return `#${s.id}「${s.title}」${s.status} · ${when} · 下次 ${f.next_at_local}`;
            }).join("\n");
            return txt(text, { ok: true, count: list.length, schedules: list.map((s) => formatSchedule(s, tz)) });
          }
          case "cancel": {
            const id = Number(p.id);
            if (!Number.isInteger(id) || id <= 0) return txt("cancel 要 id（日程编号）。", { ok: false });
            const s = d.store.getSchedule(id);
            if (!s) return txt(`没有日程 #${id}。`, { ok: false });
            if (s.status === "cancelled") return txt(`日程 #${id} 已经取消过了。`, { ok: true });
            const updated = d.store.setScheduleStatus(id, "cancelled", d.now());
            d.scheduleChanged?.();
            return txt(`已取消日程 #${id}「${s.title}」。`, { ok: true, schedule: updated ? formatSchedule(updated, tz) : null });
          }
          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${SCHEDULE_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`没成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  /**
   * 审批：执行器的权限申请会落 approvals 表，UFA 在对话里查看并裁决。
   * Web 只读，不提供裁决入口；WA 不给这个工具（自己不能批自己）。
   */
  const APPROVAL_HELP = [
    "approval 的用法（action 必填）：",
    "  list    status? task_id? limit?    看权限申请，默认全部；看板/对话都用它",
    "  get     id                         看一条的完整内容（执行器 2s 轮询同一个 id）",
    "  decide  id decision by             裁决：decision=approved|rejected，by 写裁决人",
    "  help                               看这份说明",
    "",
    "超时按拒绝处理；只有 pending 能裁决，重复裁决会报 409。",
  ].join("\n");

  const approval = defineTool({
    name: "approval",
    label: "approval",
    executionMode: "sequential",
    description:
      "查看和裁决执行器的权限申请。action 决定做什么：list（看申请，可按 status/task_id/limit 筛）/ "
      + "get（看一条）/ decide（批准 approved 或拒绝 rejected，要写 by）/ help。"
      + "执行器要动宿主机或越权的操作会落在这里等你表态；超时算拒绝。",
    parameters: Type.Object({
      action: Type.String({ description: "list / get / decide / help" }),
      id: Type.Optional(Type.Number({ description: "get、decide 用：审批 id" })),
      status: Type.Optional(Type.String({ description: `list 用：${APPROVAL_STATUSES.join(" / ")}` })),
      task_id: Type.Optional(Type.Number({ description: "list 用：只看某条任务的申请" })),
      limit: Type.Optional(Type.Number({ description: "list 用：条数" })),
      decision: Type.Optional(Type.String({ description: "decide 用：approved / rejected" })),
      by: Type.Optional(Type.String({ description: "decide 用：谁批的（用户 id）" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        switch (action) {
          case "help":
            return txt(APPROVAL_HELP, { ok: true });
          case "list": {
            if (p.status !== undefined && !isApprovalStatus(p.status)) {
              return txt(`status 只能是 ${APPROVAL_STATUSES.join(" / ")}。\n${APPROVAL_HELP}`, { ok: false });
            }
            const list = listApprovals(d.store, {
              status: p.status as any,
              taskId: p.task_id,
              limit: p.limit,
            });
            return txt(JSON.stringify(list, null, 2), { ok: true, count: list.length });
          }
          case "get": {
            if (p.id === undefined) return txt("get 要 id。", { ok: false });
            const a = getApproval(d.store, p.id);
            if (!a) return txt(`没有审批 #${p.id}`, { ok: false });
            return txt(JSON.stringify(a, null, 2), { ok: true, approval: a });
          }
          case "decide": {
            if (p.id === undefined) return txt("decide 要 id。", { ok: false });
            if (p.decision !== "approved" && p.decision !== "rejected") {
              return txt('decision 只能是 "approved" 或 "rejected"。', { ok: false });
            }
            if (!p.by?.trim()) return txt("decide 要 by（谁批的）。", { ok: false });
            const a = decideApproval(d.store, p.id, { decision: p.decision, by: p.by }, d.enqueue);
            return txt(JSON.stringify(a, null, 2), { ok: true, approval: a });
          }
          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${APPROVAL_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`没成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const TASK_HELP = [
    "task 的用法（action 必填）：",
    "  create  goal work_dir name? executor? model? start_at?             建任务（等审批通过后执行）",
    "  list    status? limit?                                              看任务",
    "  get     id                                                          看一条（带最近 3 条事件）",
    "  updates id limit?                                                   看任务池最近事件（带时间戳）",
    "  resume  id                                                          用同一 session id 恢复执行",
    "  note    id line                                                     追加说明",
    "  cancel  id                                                          取消（会先杀在跑的进程）",
    "  status  id status result? artifact?                                 改状态/回填结果",
    "  help                                                                看这份说明",
    "",
    "create 的 name 可选：给了就用它当短标签（# 自动补），不给就用系统返回的任务号。",
    "create 的 work_dir 必填且必须是已存在的绝对路径；executor 是 opencode（默认）或 mimo。",
    "deliverable / constraints / acceptance / files 只有用户明确说了才填；别替 WA 写实现计划或验收清单，它自己会读仓库约定、WA-BEST-PRACTICES.md 和 handoffs/ 里的旧交接。",
    "create 只登记成 pending_approval，不会立刻执行；开启任务审批时发到任务发起的聊天（或配置的审批房），主人贴 OK 后才启动；没开时在 Web 任务页审批。",
    "任务按工作目录起一次性进程，进度看任务池；不要自己起常驻 worker。",
    "",
    `status 只能是：${TASK_STATUSES.join(" / ")}`,
  ].join("\n");

  const parseStartAt = (v: unknown): number | undefined | null => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (!s) return undefined;
    if (/^\d+$/.test(s)) return Number(s);
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };

  const task = defineTool({
    name: "task",
    label: "task",
    executionMode: "sequential",
    description:
      "任务面板。action 决定做什么：create（建任务，必填 goal + work_dir；name / executor / model / start_at 可选。deliverable / constraints / acceptance / files 只有用户明确说了才填，别替 WA 编实现计划；objects 是业务地图对象 id，先用 map 查；建完是 pending_approval，等审批通过后才执行）/ "
      + "list（看任务，可按 status、limit 筛）/ get（看一条，带最近 3 条事件和 session_id / work_dir / executor / doc_path）/ "
      + "updates（看任务池最近事件：阶段、完成、失败、权限申请，都带时间戳）/ "
      + "resume（用同一 session id 恢复执行）/ note（追加说明）/ cancel（取消，会先杀进程）/ status（改状态或回填 result / artifact）/ help。"
      + "任务按工作目录起一次性进程，不常驻 worker；任务卡住或要权限时，把情况转述给用户。",
    parameters: Type.Object({
      action: Type.String({ description: "create / list / get / updates / resume / note / cancel / status / help" }),
      id: Type.Optional(Type.Number({ description: "get、updates、resume、note、cancel、status 用：任务 id" })),
      name: Type.Optional(Type.String({ description: "create 用：可选短标签；不给就用系统返回的任务号" })),
      work_dir: Type.Optional(Type.String({ description: "create 用：任务工作目录，必须是已存在的绝对路径" })),
      executor: Type.Optional(Type.String({ description: "create 用：opencode（默认）或 mimo" })),
      model: Type.Optional(Type.String({ description: "create 用：执行器模型，留空用执行器默认" })),
      goal: Type.Optional(Type.String({ description: "create 用：一句话说清要达成什么" })),
      deliverable: Type.Optional(Type.String({ description: "create 用：交付物长什么样" })),
      constraints: Type.Optional(Type.String({ description: "create 用：不能碰什么、必须遵守什么" })),
      acceptance: Type.Optional(Type.String({ description: "create 用：怎么算完成" })),
      files: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "create 用：相关文件路径" })),
      objects: Type.Optional(Type.Array(Type.String(), { description: "create 用：业务地图对象 id（先用 map resolve）" })),
      relations: Type.Optional(Type.Array(Type.String(), { description: "create 用：必须关注/遵守的关系 id" })),
      forbidden: Type.Optional(Type.Array(Type.String(), { description: "create 用：不能碰的对象/关系 id" })),
      start_at: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "create 用：ISO 时间或毫秒时间戳，默认现在" })),
      status: Type.Optional(Type.String({ description: `list、status 用：${TASK_STATUSES.join(" / ")}` })),
      limit: Type.Optional(Type.Number({ description: "list 用：最多几条" })),
      line: Type.Optional(Type.String({ description: "note 用：追加的一行说明" })),
      result: Type.Optional(Type.String({ description: "status 用：结果" })),
      artifact: Type.Optional(Type.String({ description: "status 用：产出物路径或链接" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        switch (action) {
          case "help":
            return txt(TASK_HELP, { ok: true });

          case "create": {
            if (!p.goal?.trim()) return txt("create 要 goal：一句话说清要达成什么。", { ok: false });
            const workDir = String(p.work_dir ?? "").trim();
            if (!workDir) return txt("create 要 work_dir：任务的绝对工作目录。", { ok: false });
            if (!path.isAbsolute(workDir)) return txt(`work_dir 必须是绝对路径：${workDir}`, { ok: false });
            let stat: fs.Stats;
            try { stat = fs.statSync(workDir); } catch { return txt(`work_dir 不存在：${workDir}`, { ok: false }); }
            if (!stat.isDirectory()) return txt(`work_dir 不是目录：${workDir}`, { ok: false });
            const executor = p.executor === undefined ? "opencode" : String(p.executor);
            if (executor !== "opencode" && executor !== "mimo") {
              return txt('executor 只能是 "opencode" 或 "mimo"。', { ok: false });
            }
            const poolId = d.primaryPool?.() ?? "";
            if (!poolId) return txt("建任务需要知道是哪个池，这一轮没有对应的池。", { ok: false });
            const startAt = parseStartAt(p.start_at);
            if (startAt === null) return txt("start_at 看不懂：给 ISO 时间或毫秒时间戳。", { ok: false });
            const context = {
              objects: Array.isArray(p.objects) ? p.objects : [],
              relations: Array.isArray(p.relations) ? p.relations : [],
              forbidden: Array.isArray(p.forbidden) ? p.forbidden : [],
            };
            if (context.objects.length || context.relations.length || context.forbidden.length) {
              const map = loadBusinessMap(d.store);
              if (!map) {
                return txt("还没有业务地图：先在 runtime/business/ 下放 objects.json / relations.json，再给任务带 objects。", { ok: false });
              }
              const bad = [...new Set([...context.objects, ...context.relations, ...context.forbidden])]
                .filter((id) => !map.byId.has(id) && !map.relationsById.has(id));
              if (bad.length) {
                return txt(`业务地图里没有这些 id：${bad.join(", ")}。先用 map index / resolve 查。`, { ok: false });
              }
            }
            const created = createTask(d.store, {
              userId: d.store.lastUserId(poolId) ?? "ufa",
              poolId,
              name: p.name ?? "",
              goal: p.goal,
              deliverable: p.deliverable,
              constraints: p.constraints,
              acceptance: p.acceptance,
              files: p.files,
              context,
              start_at: startAt,
              work_dir: workDir,
              executor,
              model: p.model,
              status: "pending_approval",
            });
            const view = formatTask(created);
            const gate = d.taskApproval;
            let notice = "等待 Web 审批，审批通过后才执行。";
            if (gate?.enabled) {
              let sent = false;
              // 审批通知发失败不影响任务本身：任务仍在，回退到 Web 审批
              try { sent = await gate.notify(created); } catch { sent = false; }
              notice = sent
                ? "已发审批提示，等主人贴 OK 批准后执行。"
                : "审批消息没发出去（任务仍在 pending_approval），可在 Web 任务页审批。";
            }
            return txt(
              `已建任务 #${created.id}${created.name ? `「${created.name}」` : ""}，${notice}`,
              { ok: true, task: view },
            );
          }

          case "list": {
            if (p.status !== undefined && !isTaskStatus(p.status)) {
              return txt(`status 只能是 ${TASK_STATUSES.join(" / ")}。\n${TASK_HELP}`, { ok: false });
            }
            const list = listTaskViews(d.store, {
              status: p.status as any,
              limit: p.limit,
            });
            return txt(JSON.stringify(list, null, 2), { ok: true, count: list.length, tasks: list });
          }

          case "get": {
            if (p.id === undefined) return txt("get 要 id。", { ok: false });
            const view = getTaskView(d.store, p.id, { recentEvents: 3 });
            if (!view) return txt(`没有任务 #${p.id}`, { ok: false });
            return txt(JSON.stringify(view, null, 2), { ok: true, task: view });
          }

          case "updates": {
            if (p.id === undefined) return txt("updates 要 id。", { ok: false });
            const task = getTask(d.store, p.id);
            if (!task) return txt(`没有任务 #${p.id}`, { ok: false });
            const name = taskDisplayName(task);
            const events = listTaskEvents(d.store, p.id, { limit: p.limit ?? 20 });
            const body = events.map((e) => `[${e.seq}] ${e.local} ${e.sender}：${e.text}`).join("\n");
            return txt(
              body ? `任务 #${task.id}「${name}」\n${body}` : `任务 #${task.id}「${name}」：这个任务池里还没有事件`,
              { ok: true, task_id: task.id, name, count: events.length, events },
            );
          }

          case "resume": {
            if (p.id === undefined) return txt("resume 要 id。", { ok: false });
            const task = getTask(d.store, p.id);
            if (!task) return txt(`没有任务 #${p.id}`, { ok: false });
            if (!task.session_id.trim()) {
              return txt(`#${p.id} 没有 session_id，不能恢复；请先 start 或重新创建。`, { ok: false });
            }
            if (isRunnerAlive(task.runner_pid)) return txt(`#${p.id} 已在运行。`, { ok: false });
            const deps = d.dispatch ?? defaultDispatchDeps(d.cfg);
            const resumed = await resumeTask(d.store, task, deps);
            const view = formatTask(resumed.task);
            return txt(`#${resumed.task.id} 恢复执行（session=${resumed.session_id}）。`, { ok: true, task: view });
          }

          case "note": {
            if (p.id === undefined) return txt("note 要 id。", { ok: false });
            if (!p.line?.trim()) return txt("note 要 line：追加的一行说明。", { ok: false });
            const updated = appendNote(d.store, p.id, p.line);
            const view = formatTask(updated);
            return txt(`#${updated.id} 追加了说明：${p.line}`, { ok: true, task: view });
          }

          case "cancel": {
            if (p.id === undefined) return txt("cancel 要 id。", { ok: false });
            const task = getTask(d.store, p.id);
            if (!task) return txt(`没有任务 #${p.id}`, { ok: false });
            if (isRunnerAlive(task.runner_pid)) await stopTask(d.store, task, { dataDir: d.cfg.dataDir });
            const updated = cancelTask(d.store, p.id);
            const view = formatTask(updated);
            return txt(`#${updated.id} 已取消。`, { ok: true, task: view });
          }

          case "status": {
            if (p.id === undefined) return txt("status 要 id。", { ok: false });
            if (!p.status?.trim()) return txt("status 要 status。", { ok: false });
            if (!isTaskStatus(p.status)) {
              return txt(`status 只能是 ${TASK_STATUSES.join(" / ")}。\n${TASK_HELP}`, { ok: false });
            }
            const updated = updateTask(d.store, p.id, {
              status: p.status,
              result: p.result,
              artifact: p.artifact,
            });
            const view = formatTask(updated);
            return txt(`#${updated.id} 状态改成 ${updated.status}。`, { ok: true, task: view });
          }

          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${TASK_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`没成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  /**
   * 文件与 shell 也做成原生工具（对齐 hermes 的 read_file / write_file / terminal）。
   *
   * 原来这三件事挂在 `read_file|write|run` 上——那等于用一条字符串命令模拟文件读写，
   * 路径里带空格或中文就得赌拼参数的那一段。工具拿的是结构化参数，路径不经过切词。
   */
  // 话题库是可选扩展：关掉后不从工具描述里出现，也不让读写 topics/。
  const topicsOn = d.cfg.topics?.enabled === true;
  const topicsNote = topicsOn ? "话题库在 topics/（只放闲聊谈资），" : "";
  const examples = {
    readPath: topicsOn ? "topics/INDEX.md" : "prompt/system.md",
    writePath: "skills/<name>/data/notes.md",
    shell: topicsOn ? "rg -n '关键词' topics" : "rg -n '关键词' prompt",
  };

  const readFile = defineTool({
    name: "read_file",
    label: "read_file",
    executionMode: "sequential",
    description:
      `读文件。默认 scope=sandbox，读 /work（runtime）里的 prompt/、skills/、shared/；`
      + "scope=host 读宿主机，只有白名单根目录直接可读，白名单外会发审批申请，批准后自动加入白名单。"
      + "文件太长会被截断，截断时会告诉你。提示词在沙盒里的 prompt/*.md，直接改。",
    parameters: Type.Object({
      path: Type.String({ description: `路径；sandbox 用相对路径，例如 ${examples.readPath}；host 用绝对路径或 ~/...` }),
      scope: Type.Optional(Type.String({ description: "sandbox（默认）/ host" })),
    }),
    async execute(_id, p) {
      const raw = String(p.path ?? "").trim();
      const scope = String(p.scope ?? "sandbox").trim().toLowerCase();
      if (scope === "host") {
        if (!raw || (!raw.startsWith("~") && !path.isAbsolute(raw))) {
          return txt("scope=host 要绝对路径或 ~/...", { ok: false });
        }
        const target = path.resolve(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw);
        if (!hostReadAllowed(d.cfg, target)) {
          if (!d.approval?.enabled) {
            return txt(`宿主读取不在白名单：${target}。审批没开，先让主人把根目录加到 exec.shell.host.readRoots。`, { ok: false, needAllow: true });
          }
          const r = await d.approval.request({ cmd: target, cwd: path.dirname(target), why: "读取宿主文件（批准后加入白名单）" });
          if (r.decision !== "approved") {
            return txt(`宿主读取没批（${r.decision}），没读：${target}`, { ok: false, denied: true });
          }
          rememberHostReadRoot(d.cfg, target);
        }
        try {
          const st = fs.statSync(target);
          if (st.isDirectory()) return txt(`这是目录：${target}（用 terminal 列目录）`, { ok: false });
          if (st.size > d.cfg.exec.maxFileBytes) return txt(`文件太大：${st.size} 字节（上限 ${d.cfg.exec.maxFileBytes}）`, { ok: false });
          const buf = fs.readFileSync(target);
          if (buf.includes(0)) return txt(`不是文本文件：${target}`, { ok: false });
          const max = d.cfg.exec.maxReadChars;
          let content = buf.toString("utf8");
          if (content.length > max) content = `${content.slice(0, max)}\n…（已截断，共 ${content.length} 字）`;
          return txt(content.trim() || "（文件是空的）", { ok: true, path: target, scope: "host" });
        } catch (e) {
          return txt(`读不了：${(e as Error).message}`, { ok: false });
        }
      }
      if (scope !== "sandbox") return txt("scope 只能是 sandbox / host", { ok: false });
      if (!topicsOn && (raw === "topics" || raw.startsWith("topics/"))) {
        return txt("话题库扩展没启用；业务知识按 system 里的「知识落点」处理。", { ok: false, topics: false });
      }
      try {
        const r = readSandboxFile(d.cfg, raw, d.readRoot);
        return txt(String(r.content ?? "").trim() || "（文件是空的）", { ok: true, path: r.path, scope: "sandbox" });
      } catch (e) {
        return txt(`读不了：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    label: "write_file",
    executionMode: "sequential",
    description:
      "写沙盒里的文件（整份覆盖，不是追加）。笔记、技能运行时产物、任务产出都写这里。"
      + "要追加就先用 read_file 读出全文，合并后整份写回。",
    parameters: Type.Object({
      path: Type.String({ description: `相对路径，比如 ${examples.writePath}` }),
      content: Type.String({ description: "完整内容" }),
    }),
    async execute(_id, p) {
      const rel = String(p.path ?? "");
      if (!topicsOn && (rel === "topics" || rel.startsWith("topics/"))) {
        return txt("话题库扩展没启用；业务知识按 system 里的「知识落点」处理。", { ok: false, topics: false });
      }
      try {
        const r = writeSandboxFile(d.cfg, rel, String(p.content ?? ""));
        return txt(`写了 ${r.path}（${r.bytes} 字节）。`, { ok: true, path: r.path });
      } catch (e) {
        return txt(`没写成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  // 沙盒内结构化编辑：写文件 / 唯一替换。只碰 /work，不碰宿主。
  const editFile = defineTool({
    name: "edit_file",
    label: "edit_file",
    executionMode: "sequential",
    description:
      "编辑沙盒里的文本文件（只碰 /work）。action=write 整份覆盖；action=replace 用 old→new 改一段（old 必须唯一命中）。"
      + "改提示词、技能、shared/projects 下的文件都用它，别用 terminal 拼 heredoc。",
    parameters: Type.Object({
      path: Type.String({ description: "沙盒相对路径，例如 prompt/scene-message.md" }),
      action: Type.String({ description: "write / replace" }),
      content: Type.Optional(Type.String({ description: "write 用：完整新内容" })),
      old: Type.Optional(Type.String({ description: "replace 用：要被替换的原文（必须唯一命中）" })),
      new: Type.Optional(Type.String({ description: "replace 用：替换后的文本" })),
    }),
    async execute(_id, p) {
      const rel = String(p.path ?? "").trim();
      if (!rel) return txt("给 path。", { ok: false });
      if (!topicsOn && (rel === "topics" || rel.startsWith("topics/"))) {
        return txt("话题库扩展没启用；业务知识按 system 里的「知识落点」处理。", { ok: false, topics: false });
      }
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        if (action === "write") {
          if (typeof p.content !== "string") return txt("write 要给 content。", { ok: false });
          const r = writeSandboxFile(d.cfg, rel, p.content, d.readRoot);
          return txt(`写了 ${r.path}（${r.bytes} 字节）。`, { ok: true, path: r.path });
        }
        if (action === "replace") {
          const oldText = String(p.old ?? "");
          const newText = String(p.new ?? "");
          if (!oldText.trim()) return txt("replace 要给 old。", { ok: false });
          const cur = readSandboxFile(d.cfg, rel, d.readRoot).content;
          const hits = cur.split(oldText).length - 1;
          if (hits === 0) return txt(`没找到这段原文：${oldText.slice(0, 80)}`, { ok: false });
          if (hits > 1) return txt(`这段原文出现 ${hits} 次，不唯一；把上下文带长一点。`, { ok: false });
          const r = writeSandboxFile(d.cfg, rel, cur.replace(oldText, newText), d.readRoot);
          return txt(`改了 ${r.path}。`, { ok: true, path: r.path });
        }
        return txt("action 只能是 write / replace。", { ok: false });
      } catch (e) {
        return txt(`没改成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  // UFA 的硬上限：默认 5 秒，超过直接失败，逼长活写成任务交给 WA
  const shellMaxSec = d.profile === "ufa"
    ? Math.max(1, Math.floor(d.cfg.exec.shell.ufaMaxTimeoutMs / 1000))
    : 600;
  const shellDefaultForProfile = shellTimeoutSec(d.profile, d.cfg);

  const runShellTool = defineTool({
    name: "terminal",
    label: "terminal",
    executionMode: "sequential",
    description:
      (d.cfg.exec.shell.mode === "host"
        ? "在**宿主机**上跑一条命令（不再是容器，碰得到真实文件）。写文件、建目录、跑脚本都走它；"
          + "会改状态的命令要先过主人的审批，审批没过就不会执行。"
        : "在沙盒容器里跑一条命令（碰不到宿主文件系统，/work 可写，内置 rg）。")
      + `用来列目录（ls、rg --files）、搜内容、算数、批量处理；默认 ${shellDefaultForProfile} 秒，最多 ${shellMaxSec} 秒`
      + (d.profile === "ufa" ? "——长活写成任务交给 WA，别在这里磨。" : "（构建、装包、转录这类长活别拆碎）。")
      + "输出太大时会截断并把全文落盘，回话里带路径。只读文件用 read_file 更快。",
    parameters: Type.Object({
      cmd: Type.String({ description: `完整命令行，例如 ${examples.shell}` }),
      timeout_sec: Type.Optional(Type.Number({ description: `超时秒数；UFA 最多 ${shellMaxSec}，WA 最多 600` })),
      cwd: Type.Optional(Type.String({ description: "工作目录；sandbox 用容器内 /work/...，host 用宿主绝对路径；不填就是沙盒根" })),
    }),
    async execute(_id, p) {
      const cmd = String(p.cmd ?? "");
      /** 过审批的那条序号：执行完拿它回报结果 */
      let pendingId = 0;
      try {
        // 只有在宿主机上裸跑时才设闸：docker 模式下容器本身就是边界
        if (d.cfg.exec.shell.mode === "host") {
          const hostCfg = d.cfg.exec.shell.host ?? {};
          const cwd = path.resolve(String(hostCfg.cwd ?? d.cfg.exec.dir));
          const v = classify(cmd, {
            allowedRoots: [path.resolve(d.cfg.exec.dir)],
            cwd,
            home: os.homedir(),
            extraSafe: d.cfg.exec.shell.safeProgs ?? [],
          });
          if (v.verdict === "deny") return txt(`这条不许跑：${v.why}。`, { ok: false, denied: true });
          if (v.verdict === "ask") {
            if (!d.approval || !d.approval.enabled) {
              return txt(`这条要和主人确认才能跑（${v.why}），审批没开，我没动。`, { ok: false, denied: true });
            }
            const r = await d.approval.request({ cmd, cwd, why: v.why });
            pendingId = r.id;
            if (r.decision !== "approved") {
              const why = r.decision === "timeout" ? "没等到批准" : "主人说不行";
              // 审批被拒＝本轮强制收手：不换命令重试，不把同一条指令拆成别的写法再问。
              // halt 由引擎读到后 abort 当前会话回合。
              return {
                ...txt(`${why}，我没跑（${v.why}）。本轮到此为止，别再换条命令重试。`, {
                  ok: false, denied: true, decision: r.decision, halt: `approval-${r.decision}`,
                }),
                terminate: true,
              };
            }
          }
        }
        const t0 = Date.now();
        // 输出超限时落盘，别让模型只看到开头几百字还以为命令没跑完整。
        // sandbox 模式落到 /work/shared/tool-output，UFA 才读得到全文。
        const overflowName = `term-${Date.now()}.log`;
        const overflowFile = d.cfg.exec.shell.mode === "docker"
          ? path.join(d.cfg.exec.dir, "shared", "tool-output", overflowName)
          : path.join(d.cfg.dataDir, "tool-output", overflowName);
        const timeoutSec = shellTimeoutSec(d.profile, d.cfg, p.timeout_sec);
        const r = await execShell(d.cfg, cmd, timeoutSec, {
          cwd: p.cwd ? String(p.cwd) : undefined,
          overflowFile,
        });
        // 过了审批的那条，把结果也回一句到审批房：他要知道自己批的那下有没有真跑成
        if (d.cfg.exec.shell.mode === "host" && d.approval) {
          d.approval.reportDone((pendingId ?? 0), { ok: !!r.ok, code: Number(r.code ?? 0), ms: Date.now() - t0 });
        }
        let out = String(r.output ?? "").trim();
        if (d.cfg.exec.shell.mode === "docker") {
          out = out.split(overflowFile).join(path.posix.join("/work", "shared", "tool-output", overflowName));
        }
        return txt(out || `（命令跑完了，没有输出；退出码 ${r.code}）`, { ok: r.ok, code: r.code });
      } catch (e) {
        return txt(`跑不了：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const MAP_HELP = [
    "map 的用法（只读）：",
    "  index                    看业务地图骨架（对象类型 / 关系 / 数量）",
    "  show <id>                看一个对象和它的直接关系",
    "  resolve <说法>           把「那个项目」这类说法解析成候选对象",
    "  path <from> <to>         找两个对象之间的关系路径",
    "  impact <id>              看改这个对象会影响谁",
    "  lint                     只读检查异常（悬空引用/没边/没证据/重名）",
    "  help                     看这份说明",
  ].join("\n");

  const mapTool = defineTool({
    name: "map",
    label: "map",
    executionMode: "sequential",
    description:
      "业务地图（只读）：先看 index 骨架，再 show / resolve / path / impact 逐层下钻；"
      + "lint 只读检查异常（悬空引用、关系没边、边没证据、重名）。"
      + "关系是显式声明的，不要猜；查不到就说查不到，别编关系。",
    parameters: Type.Object({
      action: Type.String({ description: "index / show / resolve / path / impact / lint / help" }),
      id: Type.Optional(Type.String({ description: "show、impact 用：对象 id" })),
      term: Type.Optional(Type.String({ description: "resolve 用：用户说的词或别名" })),
      from: Type.Optional(Type.String({ description: "path 用：起点对象 id" })),
      to: Type.Optional(Type.String({ description: "path 用：终点对象 id" })),
      depth: Type.Optional(Type.Number({ description: "path/impact 用：最大深度，path 默认 4，impact 默认 3" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        if (action === "help") return txt(MAP_HELP, { ok: true });
        if (action === "lint") {
          const report = lintBusinessMap(d.store);
          const body = report.findings.length
            ? report.findings.map((f) => `${f.level} [${f.code}] ${f.message}${f.ref ? `（${f.ref}）` : ""}`).join("\n")
            : "没有发现异常。";
          return txt(
            `业务地图 lint：error ${report.summary.error} / warn ${report.summary.warn} / info ${report.summary.info}\n${body}`,
            { ok: true, summary: report.summary, findings: report.findings },
          );
        }
        const map = loadBusinessMap(d.store);
        if (!map) {
          return txt("还没有业务地图：在 runtime/business/ 下放 objects.json / relations.json 后再查。", { ok: false });
        }
        switch (action) {
          case "index":
            return txt(renderIndex(map), {
              ok: true, types: map.types.length, relations: map.relations.length, objects: map.objects.length,
            });
          case "show": {
            if (!p.id?.trim()) return txt("show 要 id（对象 id 或 resolve 出来的 id）。", { ok: false });
            let view = showObject(map, p.id.trim());
            if (!view) {
              const hits = resolveObjects(map, p.id);
              if (hits.length === 1) view = showObject(map, hits[0].object.id);
              if (!view) {
                const list = hits.map((h) => `${h.object.id}（${h.object.name}，${h.reason}）`).join("\n");
                return txt(hits.length ? `没有精确的 ${p.id}，候选：\n${list}` : `地图里没有 ${p.id}。`, { ok: false });
              }
            }
            const lines = [`${view.object.id}（${view.object.name}，${view.object.type}）`];
            if (view.object.description) lines.push(view.object.description);
            if (view.object.aliases?.length) lines.push(`别名：${view.object.aliases.join(" / ")}`);
            for (const n of view.outgoing) {
              lines.push(`→ ${n.relationName} → ${n.other.id}（${n.other.name}）${n.risk === "high" ? " [high]" : ""}`);
            }
            for (const n of view.incoming) {
              lines.push(`← ${n.relationName} ← ${n.other.id}（${n.other.name}）${n.risk === "high" ? " [high]" : ""}`);
            }
            return txt(lines.join("\n"), { ok: true, object: view.object.id });
          }
          case "resolve": {
            if (!p.term?.trim()) return txt("resolve 要 term：用户说的词或别名。", { ok: false });
            const hits = resolveObjects(map, p.term);
            if (!hits.length) return txt(`没找到「${p.term}」。用 map index 看有哪些对象。`, { ok: true, count: 0 });
            return txt(
              hits.map((h) => `${h.object.id}（${h.object.name}，${h.object.type}；${h.reason}）`).join("\n"),
              { ok: true, count: hits.length, hits: hits.map((h) => h.object.id) },
            );
          }
          case "path": {
            if (!p.from?.trim() || !p.to?.trim()) return txt("path 要 from 和 to（对象 id）。", { ok: false });
            const paths = findPaths(map, p.from.trim(), p.to.trim(), p.depth ?? 4);
            if (!paths.length) {
              return txt(`没找到 ${p.from} → ${p.to} 的路径（也可能是没数据，不是没关系）。`, { ok: true, count: 0 });
            }
            return txt(paths.map((x) => formatPath(map, x)).join("\n"), { ok: true, count: paths.length });
          }
          case "impact": {
            if (!p.id?.trim()) return txt("impact 要 id（对象 id）。", { ok: false });
            const hits = impactOf(map, p.id.trim(), p.depth ?? 3);
            if (!hits.length) return txt(`没有对象依赖 ${p.id}。`, { ok: true, count: 0 });
            return txt(
              hits.map((h) => `${h.object.id}（${h.object.name}）← ${h.relation}（深度 ${h.depth}）`).join("\n"),
              { ok: true, count: hits.length },
            );
          }
          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${MAP_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`业务地图有问题：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const rb = defineTool({
    name: "rb",
    label: "rb",
    executionMode: "sequential",
    description:
      "运维与查询用：翻历史、看池、列计划、看任务、读图片、搜网页。"
      + "命令：pool-list / pool-read / pool-search / plan-list / mem-search / img-list / img-get / "
      + "task-list / web-search / web-fetch。"
      + "记事、改记忆、加计划、标完成、读写文件都有专门的工具（memory / plan / "
      + "read_file / write_file），任务写操作走 task 工具，别用 rb 做这些。"
      + "args 传完整参数串，例如 args=\"pool-list\"、args=\"mem-add --user u1 --content 他周一要交报告 --pool p1\"、"
      + "args=\"sb run \\\"ls -la\\\"\"。不确定就 args=\"help\"。",
    parameters: Type.Object({ args: Type.String({ description: "命令 + 参数，例如 \"plan-list\" 或 \"sb read notes/todo.md\"" }) }),
    async execute(_id, p) {
      const parts = splitArgs(String(p.args ?? "").trim());
      if (!parts.length) return txt("缺少命令。用 args=\"help\" 看清单", { ok: false });
      // 业务写入从这里挪走了：记忆和计划走结构化工具，rb 只管运维和查询
      const moved: Record<string, string> = {
        "mem-add": "memory action=add",
        "mem-close": "memory action=expire",
        "plan-add": "shared/projects/<slug>/plan.md（直接改文件）",
        "plan-update": "shared/projects/<slug>/plan.md（直接改文件）",
        sb: "read_file / write_file / terminal",
      };
      if (moved[parts[0]]) {
        return txt(`\`rb ${parts[0]}\` 已经不在这里用了，改用 ${moved[parts[0]]}（结构化参数，路径不用拼）。`, { ok: false, useTool: moved[parts[0]] });
      }
      try {
        const flag = (name: string): string | undefined => {
          const i = parts.indexOf(`--${name}`);
          return i >= 0 ? parts[i + 1] : undefined;
        };
        if (parts[0] === "task-list") {
          const status = flag("status") ?? (parts[1] && !parts[1].startsWith("--") ? parts[1] : undefined);
          if (status !== undefined && !isTaskStatus(status)) {
            return txt(`status 只能是 ${TASK_STATUSES.join(" / ")}。`, { ok: false });
          }
          const rawLimit = flag("limit");
          const limit = rawLimit === undefined ? undefined : Number(rawLimit);
          if (limit !== undefined && !Number.isFinite(limit)) return txt("limit 要是数字。", { ok: false });
          const list = listTaskViews(d.store, { status: status as any, limit });
          return txt(JSON.stringify(list, null, 2), { ok: true, count: list.length });
        }
        // RB_NOW 让模拟器里的「现在」和这一轮一致（plan-add 的过期判断会用到）
        const opts = shellRunnerOptions(d.cfg, 60_000);
        const exec = d.rbExec ?? ((argv: string[]) => runSandboxArgv(["rb", ...argv], { ...opts, execEnv: { RB_NOW: String(d.now()) } }));
        const r = await exec(parts);
        return txt(r.output.trim() || "（没有输出）", { ok: r.ok, code: r.code });
      } catch (e) {
        return txt(`rb 失败：${(e as Error).message}`, { ok: false });
      }
    },
  });

  // 沙盒本身就是边界，不用审批；宿主机裸跑才必须审批。
  const ufaHasTerminal = d.cfg.exec.shell.mode === "docker"
    || (d.cfg.exec.shell.mode === "host" && d.cfg.approval.enabled === true);
  // UFA：对话、记忆/知识、日程、审批、任务、读文件、map、terminal、rb。
  // 目标看板已下线；提示词在沙盒卷里，直接改，不再走 edit_prompt。
  const ufaTools = [
    chat, memory, knowledge, schedule, approval, task, readFile, editFile, mapTool,
    ...(ufaHasTerminal ? [runShellTool] : []),
    rb,
  ];
  // WA 才需要写文件和跑命令。
  const waTools = [readFile, writeFile, runShellTool, rb, knowledge];
  // 后台记忆梳理：只给 memory，不能发消息、建任务、建技能、改业务地图。
  if (d.profile === "review") return [memory];
  return d.profile === "wa" ? waTools : ufaTools;
}
