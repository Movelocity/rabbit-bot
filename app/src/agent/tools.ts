/** Agent 的自定义工具（pi customTools）。send 是唯一的输出通道。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import type { Hub } from "../core/hub.ts";
import { fmtGrouped } from "./prompt.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveImage, toImageContent } from "../core/media.ts";
import { resolveImagePath } from "../ops/images.ts";
import { shellRunnerOptions, readSandboxFile, writeSandboxFile, execShell, shellTimeoutSec } from "../ops/exec.ts";
import { runSandboxArgv } from "../core/shell-runner.ts";
import { businessDir, sharedDir } from "../core/runtime.ts";
import { coerciveHit, coerciveFeedback } from "../core/guard.ts";
import { checkStyle } from "../core/style-gate.ts";
import { classify } from "../core/cmd-rules.ts";
import type { ApprovalGate } from "../core/approval.ts";
import type { TaskApprovalGate } from "../core/task-approval.ts";
import {
  APPROVAL_STATUSES, decideApproval, getApproval, isApprovalStatus, listApprovals,
} from "../core/approvals.ts";
import { addMemory, closeMemory, searchMemories, updateMemory } from "../ops/memories.ts";
import { listPools, readPool, searchPool } from "../ops/pools.ts";
import { addPlan, updatePlan } from "../ops/plans.ts";
import {
  TASK_STATUSES, appendNote, cancelTask, createTask, getTask, isTaskStatus, taskDisplayName, updateTask,
} from "../core/tasks.ts";
import { listWorkers } from "../core/workers.ts";
import { listTaskEvents } from "../core/task-events.ts";
import {
  DEFAULT_CAPTURE_MS, isRunnerAlive, resumeTask, stopTask,
  type DispatchDeps,
} from "../core/dispatch.ts";
import { resolveApiToken } from "../api-token.ts";
import { formatTask, getTaskView, listTaskViews } from "../ops/tasks.ts";
import { findPaths, formatPath, impactOf, loadBusinessMap, renderIndex, resolveObjects, showObject } from "../ops/business-map.ts";

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
  /** 宿主机命令审批闸门（只在 exec.shell.mode=host 时被用到） */
  approval?: ApprovalGate;
  /** 任务发布审批闸门：建完任务发审批提示（原聊天或审批房）；没开就回退 Web 任务页 */
  taskApproval?: Pick<TaskApprovalGate, "enabled" | "notify">;
  /** 审批裁决后置位 pending tick 时喊一声（UFA 工具用） */
  enqueue?: () => void;
  /** 工具集归属：必填，避免漏传时回退到全量工具 */
  profile: "ufa" | "wa";
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
function fmtMemories(list: { id: number; kind: string; content: string; from: number; to: number | null; replaced_by: number | null }[]): string {
  if (!list.length) return "（没有匹配的记忆）";
  const day = (ts: number) => new Date(ts).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  return list
    .map((m) => `#${m.id} [${m.kind}] ${m.content}` + (m.to ? `（${day(m.from)} 起，${day(m.to)} 已失效${m.replaced_by ? `，被 #${m.replaced_by} 顶掉` : ""}）` : ""))
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
    "  view    path                     把一张图读进上下文（media/… 或 inbox/…）",
    "  list                             看有哪些池",
    "  search  q? pool? only? limit?    q 给了就按关键词翻原话；不给 q 就读这个池最近的消息",
    "  help                             看这份说明",
  ].join("\n");

  const chat = defineTool({
    name: "chat",
    label: "chat",
    executionMode: "sequential",
    description:
      "跟他说话，以及翻聊天记录。action 决定做什么："
      + "send（发一条，pool + content，唯一会被他看到的输出）/ skip（这一轮不回，reason 写为什么）/ "
      + "view（把一张图读进上下文，path 用 img 清单里的名字）/ list（有哪些池）/ search（按关键词翻原话，不给 q 就读最近的消息）/ help。"
      + "该说话的时候一定要 send——只调用别的工具等于这轮什么都没说。"
      + "明确不用回的时候用 skip，别用「什么都不调用」来表达沉默。",
    parameters: Type.Object({
      action: Type.String({ description: "send / skip / view / list / search / help" }),
      pool: Type.Optional(Type.String({ description: "send、search 用：池别名，如 p1" })),
      content: Type.Optional(Type.String({ description: "send 用：一条短消息；表情包写 [emoji:中文id]" })),
      reason: Type.Optional(Type.String({ description: "skip 用：一句话，为什么这一轮不用回（会记进日志）" })),
      path: Type.Optional(Type.String({ description: "view 用：media/… 或 inbox/… 开头的文件名" })),
      q: Type.Optional(Type.String({ description: "search 用：关键词，至少两个字" })),
      only: Type.Optional(Type.String({ description: "search 用：self 只看自己说的 / other 只看看他说的" })),
      limit: Type.Optional(Type.Number({ description: "search 用：条数，默认 20" })),
      before_seq: Type.Optional(Type.Number({ description: "search 不给 q 时翻页：读这个 seq 之前的" })),
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

          case "list": {
            const pools = listPools(d.store);
            if (!pools.length) return txt("（还没有任何池）", { ok: true, count: 0 });
            const lines = pools.map((x: any) => `[${x.alias}] ${x.kind === "group" ? "群" : "私聊"} ${x.title}　最后 ${x.last_msg_local ?? "—"}　共 ${x.total} 条`);
            return txt(lines.join("\n"), { ok: true, count: pools.length });
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

  const MEMORY_HELP = [
    "memory 的用法（action 必填）：",
    "  recent  [limit]                          最近记下的（默认 20 条，只给还生效的）",
    "  search  q? at? all? limit?               按关键词翻，all=1 连失效的也翻",
    "  add     content kind? supersede? from? until?   记一条",
    "  expire  id                               这条不再成立了，关掉（不写新的）",
    "  update  id content? from?                就地订正正文/起始时间，不动时间线",
    "  help                                     看这份说明",
    "",
    "只记对方明说过的具体事实，不记推断和总结。说变了的事用 add + supersede 顶掉旧的；",
    "事实没变只是不再成立（「他这周在出差」回来了）用 expire。",
  ].join("\n");

  const memory = defineTool({
    name: "memory",
    label: "memory",
    executionMode: "sequential",
    description:
      "长期记忆。action 决定做什么：recent（最近记下的）/ search（按关键词翻，all=1 连失效的）/ "
      + "add（记一条）/ expire（不再成立，关掉）/ update（就地订正）/ help。"
      + "记的是对方明说过的具体事实，不是你的推断。他说变了的事，add 时把旧条目的 #id 填进 supersede；"
      + "没有新事实、只是不再成立，用 expire。别名也走 add：kind=alias，content 写「那个项目 → 电商 AI Agent」。"
      + "拿不准就先 memory action=help。",
    parameters: Type.Object({
      action: Type.String({ description: "recent / search / add / expire / update / help" }),
      id: Type.Optional(Type.Number({ description: "expire、update 用：记忆 id（提示词里记忆前的 #号）" })),
      content: Type.Optional(Type.String({ description: "add、update 用：正文，带日期更好" })),
      kind: Type.Optional(Type.String({ description: "add 用：fact（默认）/ plan / alias / topic" })),
      supersede: Type.Optional(Type.Number({ description: "add 用：被这条顶掉的旧记忆 id" })),
      from: Type.Optional(Type.String({ description: "add、update 用：从什么时候起成立，ISO" })),
      until: Type.Optional(Type.String({ description: "add 用：到期时间，ISO" })),
      q: Type.Optional(Type.String({ description: "search 用：关键词" })),
      at: Type.Optional(Type.String({ description: "search 用：查那一刻有效，ISO" })),
      all: Type.Optional(Type.Boolean({ description: "search 用：连失效的一起给" })),
      limit: Type.Optional(Type.Number({ description: "recent、search 用：条数，默认 20" })),
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
            const r = addMemory(d.store, {
              user: userOf(p.user), content: p.content, pool: poolOf(), kind: p.kind,
              from: p.from, until: p.until, supersede: p.supersede,
            });
            return txt(r.superseded ? `记下了（#${r.id}），原来 #${r.superseded} 那条已经失效。` : `记下了（#${r.id}）。`, { ok: true, id: r.id });
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
   * 计划：一个工具，action 分四件事（add / done / list / help）。
   * 口头的承诺不落库等于没答应——他说「到点提醒我」、或者你答应了到点说一声，就是 add。
   */
  const PLAN_HELP = [
    "plan 的用法（action 必填）：",
    "  add    title when? content? why?   加一条到点提醒（when 给 ISO；重复就给 cron「分 时 日 月 周」）",
    "  done   id status?                 标完成（默认 done，作废用 status=cancelled）",
    "  list   status?                    看计划，默认 pending",
    "  help                              看这份说明",
  ].join("\n");

  const plan = defineTool({
    name: "plan",
    label: "plan",
    executionMode: "sequential",
    description:
      "到点提醒的计划。action 决定做什么：add（加一条）/ done（标完成或作废）/ list（看有哪些）/ help。"
      + "他说「几点提醒我」、或者你答应了到点说一声，就 add——口头的承诺不落库等于没答应。"
      + "他说某件事办完了，先 done 标完成，再 memory add 记一条带日期的事实。",
    parameters: Type.Object({
      action: Type.String({ description: "add / done / list / help" }),
      id: Type.Optional(Type.Number({ description: "done 用：计划 id（plan action=list 里那个）" })),
      title: Type.Optional(Type.String({ description: "add 用：提醒什么，一句话" })),
      when: Type.Optional(Type.String({ description: "add 用：ISO 时间，或 cron「分 时 日 月 周」" })),
      content: Type.Optional(Type.String({ description: "add 用：到点要说的话或细节" })),
      why: Type.Optional(Type.String({ description: "add 用：为什么记这条" })),
      status: Type.Optional(Type.String({ description: "done 用：done（默认）/ cancelled；list 用：按状态筛" })),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        switch (action) {
          case "help":
            return txt(PLAN_HELP, { ok: true });
          case "add": {
            if (!p.title) return txt("add 要 title（提醒什么）。", { ok: false });
            const isCron = !!p.when && p.when.trim().split(/\s+/).length >= 5;
            // 同一条没停之前别再排一遍：重复的计划会在同一分钟唤醒她两次，
            // 而她看到的只是「计划到点了」，不会知道是自己排了两遍。
            const dup = d.store.listPlans("pending").find((x: any) =>
              String(x.title).trim() === p.title!.trim() && String(x.schedule ?? "") === String(p.when ?? ""));
            if (dup) {
              return txt(`已经有一条一样的了（#${dup.id} ${dup.title}，${dup.schedule_kind === "cron" ? `cron ${dup.schedule}` : dup.schedule}），没重复加。要改就先把那条 done 掉。`, { ok: true, plan: dup, duplicate: true });
            }
            const r = addPlan(d.store, d.cfg.timezone, {
              title: p.title, content: p.content, why: p.why, pool: poolOf(),
              kind: isCron ? "cron" : "once", when: p.when,
            }, d.now());
            return txt(`记下了，到点会提醒（#${(r as any).id ?? "?"}）。`, { ok: true, plan: r });
          }
          case "done": {
            if (p.id === undefined) return txt("done 要 id。", { ok: false });
            const r = updatePlan(d.store, p.id, p.status ?? "done");
            return txt(`#${p.id} 标成 ${p.status ?? "done"} 了。`, { ok: true, plan: r });
          }
          case "list": {
            const list = d.store.listPlans((p.status as any) ?? "pending");
            if (!list.length) return txt(`没有 ${p.status ?? "pending"} 的计划。`, { ok: true, count: 0 });
            return txt(list.map((x: any) => `#${x.id} ${x.title}${x.status ? `（${x.status}）` : ""}`).join("\n"), { ok: true, count: list.length });
          }
          default:
            return txt(`没有 action=「${p.action}」这个动作。\n${PLAN_HELP}`, { ok: false });
        }
      } catch (e) {
        return txt(`没成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  /**
   * 审批：worker 的权限申请会落 approvals 表，UFA 在对话里查看并裁决。
   * Web 只读，不提供裁决入口；WA 不给这个工具（自己不能批自己）。
   */
  const APPROVAL_HELP = [
    "approval 的用法（action 必填）：",
    "  list    status? task_id? limit?    看权限申请，默认全部；看板/对话都用它",
    "  get     id                         看一条的完整内容（worker 2s 轮询同一个 id）",
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
      "查看和裁决 worker 的权限申请。action 决定做什么：list（看申请，可按 status/task_id/limit 筛）/ "
      + "get（看一条）/ decide（批准 approved 或拒绝 rejected，要写 by）/ help。"
      + "worker 要动宿主机或越权的操作会落在这里等你表态；超时算拒绝。",
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
    "  create  name goal work_dir executor? model? deliverable? constraints? acceptance? files? start_at?  建任务（等审批通过后执行）",
    "  list    status? limit?                                              看任务",
    "  get     id                                                          看一条（带最近 3 条事件）",
    "  updates id limit?                                                   看任务池最近事件（带时间戳）",
    "  resume  id                                                          用同一 session id 恢复执行",
    "  note    id line                                                     追加说明",
    "  cancel  id                                                          取消（会先杀在跑的进程）",
    "  status  id status result? artifact?                                 改状态/回填结果",
    "  help                                                                看这份说明",
    "",
    "create 的 name 必填，格式 #xxx（一眼认得出这是什么任务）；没带 # 会自动补上。",
    "create 的 work_dir 必填且必须是已存在的绝对路径；executor 是 opencode（默认）或 mimo。",
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
      "任务面板。action 决定做什么：create（建任务，必填 name + goal + work_dir，name 是 #xxx 短任务名，可补 executor / model / deliverable / constraints / acceptance / files / objects / relations / forbidden / start_at；objects 是业务地图对象 id，先用 map 查；建完是 pending_approval，等审批通过后才执行）/ "
      + "list（看任务，可按 status、limit 筛）/ get（看一条，带最近 3 条事件和 session_id / work_dir / executor / doc_path）/ "
      + "updates（看任务池最近事件：阶段、完成、失败、权限申请，都带时间戳）/ "
      + "resume（用同一 session id 恢复执行）/ note（追加说明）/ cancel（取消，会先杀进程）/ status（改状态或回填 result / artifact）/ help。"
      + "任务按工作目录起一次性进程，不常驻 worker；任务卡住或要权限时，把情况转述给用户。",
    parameters: Type.Object({
      action: Type.String({ description: "create / list / get / updates / resume / note / cancel / status / help" }),
      id: Type.Optional(Type.Number({ description: "get、updates、resume、note、cancel、status 用：任务 id" })),
      name: Type.Optional(Type.String({ description: "create 用：短任务名，格式 #xxx，必填；一眼认得出这是什么任务" })),
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
            if (!p.name?.trim()) return txt("需要短任务名，格式 #xxx", { ok: false });
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
              const map = loadBusinessMap(d.cfg);
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
              name: p.name,
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
              `已建任务 #${created.id}「${created.name}」，${notice}`,
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
            if (isRunnerAlive(task.runner_pid)) await stopTask(d.store, task);
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

  const WORKER_HELP = [
    "worker 的用法（action 必填）：",
    "  list   看已注册的 worker（worker_id / name / kind / status / last_seen_at）",
    "  help   看这份说明",
  ].join("\n");

  const worker = defineTool({
    name: "worker",
    label: "worker",
    executionMode: "sequential",
    description:
      "看有哪些 worker 在跑。action=list 返回 worker_id / name / kind / status / last_seen_at；"
      + "先看有没有在线的，再决定任务怎么写。派活由 worker 自己 claim，你只负责把任务写清楚。",
    parameters: Type.Object({
      action: Type.String({ description: "list / help" }),
    }),
    async execute(_id, p) {
      const action = String(p.action ?? "").trim().toLowerCase();
      try {
        if (action === "help") return txt(WORKER_HELP, { ok: true });
        if (action !== "list") return txt(`没有 action=「${p.action}」这个动作。\n${WORKER_HELP}`, { ok: false });
        const list = listWorkers(d.store).map((w) => ({
          worker_id: w.worker_id,
          name: w.name,
          kind: w.kind,
          status: w.status,
          last_seen_at: w.last_seen_at,
        }));
        return txt(JSON.stringify(list, null, 2), { ok: true, count: list.length, workers: list });
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
  const readFile = defineTool({
    name: "read_file",
    label: "read_file",
    executionMode: "sequential",
    description:
      "读工作区里的文件（只读；相对路径）。话题库在 topics/，提示词在 prompt/，技能在 skills/<name>/SKILL.md；别人写的技能库挂成 shared-skills/<name>/SKILL.md（只读）；worker 交上来的汇报在 shared/。"
      + "文件太长会被截断，截断时会告诉你。",
    parameters: Type.Object({
      path: Type.String({ description: "相对路径，例如 topics/INDEX.md" }),
    }),
    async execute(_id, p) {
      try {
        const r = readSandboxFile(d.cfg, String(p.path ?? ""), d.readRoot);
        return txt(String(r.content ?? "").trim() || "（文件是空的）", { ok: true, path: r.path });
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
      "写沙盒里的文件（整份覆盖，不是追加）。笔记、话题库条目、技能运行时产物都写这里。"
      + "要追加就先用 read_file 读出全文，合并后整份写回。",
    parameters: Type.Object({
      path: Type.String({ description: "相对路径，比如 topics/life/话题.md" }),
      content: Type.String({ description: "完整内容" }),
    }),
    async execute(_id, p) {
      try {
        const r = writeSandboxFile(d.cfg, String(p.path ?? ""), String(p.content ?? ""));
        return txt(`写了 ${r.path}（${r.bytes} 字节）。`, { ok: true, path: r.path });
      } catch (e) {
        return txt(`没写成：${(e as Error).message}`, { ok: false });
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
      cmd: Type.String({ description: "完整命令行，例如 rg -n '关键词' topics" }),
      timeout_sec: Type.Optional(Type.Number({ description: `超时秒数；UFA 最多 ${shellMaxSec}，WA 最多 600` })),
      cwd: Type.Optional(Type.String({ description: "在这条命令的工作目录里跑（绝对路径）；不填就是沙盒目录" })),
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
              return txt(`${why}，我没跑（${v.why}）。`, { ok: false, denied: true, decision: r.decision });
            }
          }
        }
        const t0 = Date.now();
        // 输出超限时落盘，别让模型只看到开头几百字还以为命令没跑完整
        const overflowFile = path.join(d.cfg.dataDir, "tool-output", `term-${Date.now()}.log`);
        const timeoutSec = shellTimeoutSec(d.profile, d.cfg, p.timeout_sec);
        const r = await execShell(d.cfg, cmd, timeoutSec, {
          cwd: p.cwd ? String(p.cwd) : undefined,
          overflowFile,
        });
        // 过了审批的那条，把结果也回一句到审批房：他要知道自己批的那下有没有真跑成
        if (d.cfg.exec.shell.mode === "host" && d.approval) {
          d.approval.reportDone((pendingId ?? 0), { ok: !!r.ok, code: Number(r.code ?? 0), ms: Date.now() - t0 });
        }
        const out = String(r.output ?? "").trim();
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
    "  help                     看这份说明",
  ].join("\n");

  const mapTool = defineTool({
    name: "map",
    label: "map",
    executionMode: "sequential",
    description:
      "业务地图（只读）：先看 index 骨架，再 show / resolve / path / impact 逐层下钻。"
      + "关系是显式声明的，不要猜；查不到就说查不到，别编关系。",
    parameters: Type.Object({
      action: Type.String({ description: "index / show / resolve / path / impact / help" }),
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
        const map = loadBusinessMap(d.cfg);
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
      "运维与查询用：翻历史、看池、列计划、看任务和 worker、读图片、搜网页。"
      + "命令：pool-list / pool-read / pool-search / plan-list / mem-search / img-list / img-get / "
      + "task-list / worker-list / web-search / web-fetch。"
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
        "plan-add": "plan action=add",
        "plan-update": "plan action=done",
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
        if (parts[0] === "worker-list") {
          const list = listWorkers(d.store).map((w) => ({
            worker_id: w.worker_id,
            name: w.name,
            kind: w.kind,
            status: w.status,
            last_seen_at: w.last_seen_at,
          }));
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
  // UFA 只读 + 任务面板：不写文件（交接走 tasks 表），terminal 按 host+审批开关。
  const ufaTools = [
    chat, memory, plan, approval, task, worker, readFile, mapTool,
    ...(ufaHasTerminal ? [runShellTool] : []),
    rb,
  ];
  // WA 才需要写文件和跑命令。
  const waTools = [readFile, writeFile, runShellTool, rb];
  return d.profile === "wa" ? waTools : ufaTools;
}
