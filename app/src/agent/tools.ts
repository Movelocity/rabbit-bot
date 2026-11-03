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
import { sandboxShellOptions, listSandboxFiles, readSandboxFile, writeSandboxFile, runSandboxShell } from "../ops/sandbox.ts";
import { runSandboxArgv } from "../core/sandbox-shell.ts";
import { coerciveHit, coerciveFeedback } from "../core/guard.ts";
import { checkStyle } from "../core/style-gate.ts";
import { addMemory, closeMemory } from "../ops/memories.ts";
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
   * 记忆与计划的四件事做成原生工具。
   *
   * 为什么不再走 `rb mem-add --content "…"`：记忆内容是自由文本，穿过 shell 要过引号、
   * 全角符号、箭头、换行，少一个转义就静默写坏一条——而写坏的记忆没人看得见，
   * 不像消息发错了立刻能发现。工具拿的是结构化参数，不进 shell，失败会当场报错。
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

  const remember = defineTool({
    name: "remember",
    label: "remember",
    executionMode: "sequential",
    description:
      "记一条长期记忆。只记对方明说过的具体事实（他说了什么、答应过什么、发生了什么），不记你的推断和总结。"
      + "他说变了的事，用 supersede 传旧条目的 #id 顶掉旧的——不顶的话你会同时相信两件矛盾的事。"
      + "没有新事实、只是不再成立（「他这周在出差」回来了），别硬编一条新的，用 forget 关掉。"
      + "别名也用这个记：kind=alias，content 写成「那个项目 → 电商 AI Agent」。",
    parameters: Type.Object({
      content: Type.String({ description: "要记的原话或事实，带日期更好：『11-03 钥匙弄好了，楼下五金店打的』" }),
      kind: Type.Optional(Type.String({ description: "fact（默认）/ plan / alias / topic" })),
      supersede: Type.Optional(Type.Number({ description: "被这条顶掉的旧记忆 id（提示词里记忆前的 #号）" })),
      from: Type.Optional(Type.String({ description: "这件事从什么时候开始成立，ISO 时间；不传就是现在" })),
      until: Type.Optional(Type.String({ description: "到期时间，ISO；只在那之前成立" })),
      user: Type.Optional(Type.String({ description: "一般不用填，默认是当前对话的人" })),
    }),
    async execute(_id, p) {
      try {
        const r = addMemory(d.store, {
          user: userOf(p.user), content: p.content, pool: poolOf(), kind: p.kind,
          from: p.from, until: p.until, supersede: p.supersede,
        });
        return txt(
          r.superseded
            ? `记下了（#${r.id}），原来 #${r.superseded} 那条已经失效。`
            : `记下了（#${r.id}）。`,
          { ok: true, id: r.id },
        );
      } catch (e) {
        return txt(`没记成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const forget = defineTool({
    name: "forget",
    label: "forget",
    executionMode: "sequential",
    description:
      "把一条记忆标成失效，不写新的。用在：这件事不再成立了，但没有新事实可写"
      + "（「他这周在出差」回来了、「我在减肥」不打算减了）。已经失效的再关一次不会改时间。",
    parameters: Type.Object({
      id: Type.Number({ description: "记忆 id（提示词里记忆前的 #号）" }),
      user: Type.Optional(Type.String({ description: "一般不用填，默认是当前对话的人" })),
    }),
    async execute(_id, p) {
      try {
        const r = closeMemory(d.store, { user: userOf(p.user), id: p.id });
        return txt(r.already ? `#${p.id} 早就失效了（${new Date(r.closed_at).toLocaleString("zh-CN")}），没动它。` : `#${p.id} 关掉了。`, { ok: true });
      } catch (e) {
        return txt(`没关成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const planAdd = defineTool({
    name: "plan_add",
    label: "plan_add",
    executionMode: "sequential",
    description:
      "加一条到点提醒。他让你几点提醒他什么、或者你答应了到点说一声，就记下来——口头的承诺不落库等于没答应。",
    parameters: Type.Object({
      title: Type.String({ description: "提醒什么，一句话" }),
      when: Type.Optional(Type.String({ description: "什么时候：ISO 时间，或者 cron 表达式（每天的就用 cron）" })),
      content: Type.Optional(Type.String({ description: "到点要说的话或细节" })),
      why: Type.Optional(Type.String({ description: "为什么记这条，一句话" })),
    }),
    async execute(_id, p) {
      try {
        const r = addPlan(d.store, d.cfg.timezone, {
          title: p.title, content: p.content, why: p.why, pool: poolOf(),
          kind: p.when && /^[\d*\/, -]+$/.test(p.when) && p.when.trim().split(/\s+/).length >= 5 ? "cron" : "once",
          when: p.when,
        }, d.now());
        return txt(`记下了，到点会提醒（#${(r as any).id ?? "?"}）。`, { ok: true });
      } catch (e) {
        return txt(`没记成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  const planDone = defineTool({
    name: "plan_done",
    label: "plan_done",
    executionMode: "sequential",
    description:
      "某事办完了就把它标成 done，别再提。他说「弄好了」「办完了」的时候，先标这个，再用 remember 记一条带日期的事实。",
    parameters: Type.Object({
      id: Type.Number({ description: "计划 id（rb \"plan-list\" 里那个）" }),
      status: Type.Optional(Type.String({ description: "done（默认）/ cancelled" })),
    }),
    async execute(_id, p) {
      try {
        const r = updatePlan(d.store, p.id, p.status ?? "done");
        return txt(`#${p.id} 标成 ${p.status ?? "done"} 了。`, { ok: true, plan: r });
      } catch (e) {
        return txt(`没标成：${(e as Error).message}`, { ok: false });
      }
    },
  });

  /**
   * 文件与 shell 也做成原生工具（对齐 hermes 的 read_file / write_file / terminal）。
   *
   * 原来这三件事挂在 `read_file|write|run` 上——那等于用一条字符串命令模拟文件读写，
   * 路径里带空格或中文就得赌拼参数的那一段。工具拿的是结构化参数，路径不经过切词。
   */
  const listFiles = defineTool({
    name: "list_files",
    label: "list_files",
    executionMode: "sequential",
    description: "列沙盒 /work 下的文件。不传 dir 就是根目录。用来找东西在哪，别靠猜路径。",
    parameters: Type.Object({
      dir: Type.Optional(Type.String({ description: "相对路径，比如 topics、skills、prompt；不传是根" })),
    }),
    async execute(_id, p) {
      try {
        const items = listSandboxFiles(d.cfg, p.dir ?? "");
        if (!items.length) return txt(`（${p.dir || "/"} 下是空的）`, { ok: true });
        return txt(items.map((f: any) => (f.dir ? `${f.path}/` : `${f.path}  ${f.bytes ?? ""}`)).join("\n"), { ok: true, count: items.length });
      } catch (e) {
        return txt(`列不出来：${(e as Error).message}`, { ok: false });
      }
    },
  });

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
      + "要追加就别用这个：用 run_shell 里的 printf >> 。",
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
    name: "run_shell",
    label: "run_shell",
    executionMode: "sequential",
    description:
      "在沙盒容器里跑一条命令（碰不到宿主文件系统，/work 可写，内置 rg）。用来搜文件、算数、批量处理；"
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
      + "记事、改记忆、加计划、标完成、读写文件、跑命令都有专门的工具（remember / forget / plan_add / plan_done / "
      + "read_file / write_file / list_files / run_shell），别用 rb 做这些。"
      + "args 传完整参数串，例如 args=\"pool-list\"、args=\"mem-add --user u1 --content 他周一要交报告 --pool p1\"、"
      + "args=\"sb run \\\"ls -la\\\"\"。不确定就 args=\"help\"。",
    parameters: Type.Object({ args: Type.String({ description: "命令 + 参数，例如 \"plan-list\" 或 \"sb read notes/todo.md\"" }) }),
    async execute(_id, p) {
      const parts = splitArgs(String(p.args ?? "").trim());
      if (!parts.length) return txt("缺少命令。用 args=\"help\" 看清单", { ok: false });
      // 业务写入从这里挪走了：记忆和计划走结构化工具，rb 只管运维和查询
      const moved: Record<string, string> = {
        "mem-add": "remember",
        "mem-close": "forget",
        "plan-add": "plan_add",
        "plan-update": "plan_done",
        sb: "read_file / write_file / list_files / run_shell",
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

  return [send, staySilent, viewImage, remember, forget, planAdd, planDone, readFile, writeFile, listFiles, runShellTool, rb];
}
