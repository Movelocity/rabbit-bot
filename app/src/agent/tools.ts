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
import { sandboxShellOptions } from "../ops/sandbox.ts";
import { runSandboxArgv } from "../core/sandbox-shell.ts";
import { coerciveHit, coerciveFeedback } from "../core/guard.ts";
import { checkStyle } from "../core/style-gate.ts";

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

  const rb = defineTool({
    name: "rb",
    label: "rb",
    executionMode: "sequential",
    description:
      "在沙盒里跑 rb 客户端（JSON 输出）。业务数据走宿主 API，文件和 shell 直接操作 /work。"
      + "命令：pool-list / pool-read / pool-search / plan-list / plan-add / plan-update / "
      + "mem-add / mem-search / img-list / img-get / web-search / web-fetch / skills / sb。"
      + "args 传完整参数串，例如 args=\"pool-list\"、args=\"mem-add --user u1 --content 他周一要交报告 --pool p1\"、"
      + "args=\"sb run \\\"ls -la\\\"\"。不确定就 args=\"help\"。",
    parameters: Type.Object({ args: Type.String({ description: "命令 + 参数，例如 \"plan-list\" 或 \"sb read notes/todo.md\"" }) }),
    async execute(_id, p) {
      const parts = splitArgs(String(p.args ?? "").trim());
      if (!parts.length) return txt("缺少命令。用 args=\"help\" 看清单", { ok: false });
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

  return [send, staySilent, viewImage, rb];
}
