/** Agent 的自定义工具（pi customTools）。send 是唯一的输出通道。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import type { Hub } from "../core/hub.ts";
import { fmtGrouped } from "./prompt.ts";
import fs from "node:fs";
import path from "node:path";
import { saveImage, toImageContent } from "../core/media.ts";
import { resolveImagePath } from "../ops/images.ts";
import { sandboxShellOptions, readSandboxFile, writeSandboxFile, runSandboxShell } from "../ops/sandbox.ts";
import { runSandboxArgv } from "../core/sandbox-shell.ts";
import { coerciveHit, coerciveFeedback } from "../core/guard.ts";
import { checkStyle } from "../core/style-gate.ts";
import { addMemory, closeMemory, searchMemories, updateMemory } from "../ops/memories.ts";
import { addPlan, updatePlan } from "../ops/plans.ts";

export type RbExec = (argv: string[]) => Promise<{ ok: boolean; code: number; output: string }>;

export interface ToolDeps {
  store: Store;
  hub: Hub;
  cfg: Config;
  now: () => number;
  /** 本轮唤醒类型；主动消息（plan）要过情感绑架护栏 */
  currentWake?: () => { type: string } | null;
  /** 本轮决定不回时的理由（stay_silent）；非空就是已决定不回 */
  silenceReason?: () => string | null;
  /** 测试注入：用进程内实现替代沙盒 rb（生产走 docker）。 */
  rbExec?: RbExec;
  markSilent?: (reason: string) => void;
  /** 这一轮的主要池：记记忆/加计划时自动落到这里，模型不用自己填池 */
  primaryPool?: () => string | null;
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

export function createTools(d: ToolDeps) {
  /**
   * 这一轮不回。它是 send 的反面，也是唯一能让「不说话」成为一个明确决定的方式——
   * 没有它，模型只能靠「什么都不调用」来表达沉默，而它倾向于用发一条消息来收尾。
   */
  const staySilent = defineTool({
    name: "stay_silent",
    label: "stay_silent",
    executionMode: "sequential",
    description:
      "这一轮不回，什么都不发。用在：对方明确说了不用回/晚点说、他只是发了个表情或语气词、到点的计划已经作废、"
      + "或者定时唤醒时你确实没有具体的事要说。调用后本轮结束，对方收不到任何消息。"
      + "这不是偷懒的借口：有具体的话要说时仍然要 send。reason 写一句话说明为什么这轮不用回（会记进日志，用来复盘）。",
    parameters: Type.Object({
      reason: Type.String({ description: "一句话：为什么这一轮不用回" }),
    }),
    async execute(_id, p) {
      d.markSilent?.(p.reason);
      return txt(`已标记：这一轮不回（${p.reason}）。什么都不用再做了，结束这一轮。`, { ok: true, silent: true });
    },
  });

  const send = defineTool({
    name: "send",
    label: "send",
    executionMode: "sequential",
    description: "向聊天池发一条消息（唯一会被用户看到的输出）。返回发送确认和这期间的新消息。",
    parameters: Type.Object({
      pool: Type.String({ description: "池别名，如 p1" }),
      content: Type.String({ description: "一条短消息；表情包写 [emoji:中文id]" }),
    }),
    async execute(_id, p) {
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
    },
  });

  // 读本地图片进上下文。只允许两个沙箱目录：data/media/（聊天里收到的图）和 data/inbox/（手动放的）。
  // rabbit-bot 收的是任意飞书用户消息，一句提示注入就能让它读走 ~/.ssh 或凭据文件，所以路径必须锁死在这两个根下。
  const viewCacheDir = path.join(d.cfg.dataDir, "cache");

  const viewImage = defineTool({
    name: "view_image",
    label: "view_image",
    executionMode: "sequential",
    description: "把一张图片加载进上下文（长边压到 1024）。path 用 `rb img-list` 给出的名字，如 media/om_xxx.jpg、inbox/shot.png。一次只加载一张。",
    parameters: Type.Object({ path: Type.String({ description: "media/… 或 inbox/… 开头的文件名" }) }),
    async execute(_id, p) {
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
    },
  });

  /**
   * 唯一的业务通道：在沙盒里跑 rb 客户端（容器内的 /usr/local/bin/rb）。
   * 业务数据走宿主 REST API，文件和 shell 直接操作 /work——宿主路径在容器里不存在。
   * 按 argv 执行、不过 shell，模型拼不出 `; rm -rf`。
   */
  const splitArgs = (line: string): string[] => {
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  };

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
      "读沙盒里的文件（/work 下的相对路径）。话题库在 topics/，提示词在 prompt/，技能在 skills/<name>/SKILL.md。"
      + "文件太长会被截断，截断时会告诉你。",
    parameters: Type.Object({
      path: Type.String({ description: "相对路径，例如 topics/INDEX.md" }),
    }),
    async execute(_id, p) {
      try {
        const r = readSandboxFile(d.cfg, String(p.path ?? ""));
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
      + "要追加就别用这个：用 terminal 里的 printf >> 。",
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

  const runShellTool = defineTool({
    name: "terminal",
    label: "terminal",
    executionMode: "sequential",
    description:
      "在沙盒容器里跑一条命令（碰不到宿主文件系统，/work 可写，内置 rg）。用来列目录（ls、rg --files）、搜内容、算数、批量处理；"
      + "单次最多 30 秒。只读文件就别用这个，read_file 更快。",
    parameters: Type.Object({
      cmd: Type.String({ description: "完整命令行，例如 rg -n '关键词' topics" }),
      timeout_sec: Type.Optional(Type.Number({ description: "超时秒数，最多 30，默认按配置" })),
    }),
    async execute(_id, p) {
      try {
        const r = await runSandboxShell(d.cfg, String(p.cmd ?? ""), p.timeout_sec);
        const out = String(r.output ?? "").trim();
        return txt(out || `（命令跑完了，没有输出；退出码 ${r.code}）`, { ok: r.ok, code: r.code });
      } catch (e) {
        return txt(`跑不了：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const rb = defineTool({
    name: "rb",
    label: "rb",
    executionMode: "sequential",
    description:
      "运维与查询用：翻历史、看池、列计划、读图片、搜网页、在沙盒里跑命令。"
      + "命令：pool-list / pool-read / pool-search / plan-list / mem-search / img-list / img-get / "
      + "web-search / web-fetch / skills。"
      + "记事、改记忆、加计划、标完成、读写文件、跑命令都有专门的工具（memory / plan / "
      + "read_file / write_file / terminal），别用 rb 做这些。"
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
        // RB_NOW 让模拟器里的「现在」和这一轮一致（plan-add 的过期判断会用到）
        const opts = sandboxShellOptions(d.cfg, 60_000);
        const exec = d.rbExec ?? ((argv: string[]) => runSandboxArgv(["rb", ...argv], { ...opts, execEnv: { RB_NOW: String(d.now()) } }));
        const r = await exec(parts);
        return txt(r.output.trim() || "（没有输出）", { ok: r.ok, code: r.code });
      } catch (e) {
        return txt(`rb 失败：${(e as Error).message}`, { ok: false });
      }
    },
  });

  return [send, staySilent, viewImage, memory, plan, readFile, writeFile, runShellTool, rb];
}
