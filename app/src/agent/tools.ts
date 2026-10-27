/** Agent 的自定义工具（pi customTools）。send 是唯一的输出通道。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import type { Hub } from "../core/hub.ts";
import { validateSchedule } from "../core/plans.ts";
import { parseIsoInTz, fmtLocal } from "../core/time.ts";
import type { MemoryScope } from "../types.ts";
import { fmtGrouped, fmtMsg, poolLabel } from "./prompt.ts";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { saveImage, toImageContent } from "../core/media.ts";
import { createSandboxFs } from "../core/sandbox-fs.ts";
import { runInSandbox } from "../core/sandbox-shell.ts";
import { coerciveHit, coerciveFeedback } from "../core/guard.ts";

export interface ToolDeps {
  store: Store;
  hub: Hub;
  cfg: Config;
  now: () => number;
  /** 本轮唤醒类型；主动消息（plan）要过情感绑架护栏 */
  currentWake?: () => { type: string } | null;
  /** 本轮决定不回时的理由（stay_silent）；非空就是已决定不回 */
  silenceReason?: () => string | null;
  markSilent?: (reason: string) => void;
}

const execFileAsync = promisify(execFile);
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
      const r = await d.hub.send(p.pool, p.content);
      if (!r.ok) return txt(`发送失败：${r.error}${r.newMessages.length ? `\n新消息：\n${fmtGrouped(d.store, r.newMessages)}` : ""}`, { ok: false });
      const unconfirmed = r.sentParts.filter((x) => !x.confirmed).length;
      const head = unconfirmed ? `已发送，但有 ${unconfirmed} 段暂未确认出现在聊天里` : "已发送并确认";
      const tail = r.newMessages.length ? `\n期间新消息：\n${fmtGrouped(d.store, r.newMessages)}` : "\n期间无新消息";
      return txt(head + tail, { ok: true, newCount: r.newMessages.length });
    },
  });


  const readPool = defineTool({
    name: "read_pool",
    label: "read_pool",
    executionMode: "sequential",
    description: "读某个池的历史消息（不影响未读游标）。",
    parameters: Type.Object({
      pool: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      before_seq: Type.Optional(Type.Integer({ description: "只看此 #seq 之前" })),
    }),
    async execute(_id, p) {
      const pool = d.store.resolvePool(p.pool);
      if (!pool) return txt(`未知的池 ${p.pool}`);
      const limit = p.limit ?? 15;
      const msgs = d.store.recentMessages(pool.pool_id, limit, p.before_seq ? p.before_seq - 1 : undefined);
      const span = d.store.poolSpan(pool.pool_id);
      const oldest = span.first ? `最早 #${span.first.seq}` : "空池";
      const range = msgs.length ? `#${msgs[0].seq}–#${msgs[msgs.length - 1].seq}` : "无";
      const head = `本池共 ${span.total} 条（${oldest}）；这段 ${range}${p.before_seq ? "" : "，要往前翻就传 before_seq"}。`;
      return txt(`${head}\n${msgs.map((m) => fmtMsg(m)).join("\n") || "（无消息）"}`, { total: span.total, shown: msgs.length });
    },
  });

  // 按关键词翻旧账：比一页页 read_pool 快，命中的 #seq 再拿去 read_pool 看上下文。
  const searchMessages = defineTool({
    name: "search_messages",
    label: "search_messages",
    executionMode: "sequential",
    description: "在聊天记录里按关键词搜（找很久以前聊过的事、某个名字、某句话）。比一页页翻 read_pool 快多了；命中后可用 read_pool 的 before_seq 看上下文。",
    parameters: Type.Object({
      pool: Type.String({ description: "池别名，如 p1" }),
      keyword: Type.String({ description: "关键词，2-30 字" }),
      limit: Type.Optional(Type.Integer({ description: "最多返回几条 1-30，默认 15" })),
    }),
    async execute(_id, p) {
      const pool = d.store.resolvePool(p.pool);
      if (!pool) return txt(`未知的池 ${p.pool}`);
      const kw = String(p.keyword || "").trim().slice(0, 30);
      if (kw.length < 2) return txt("关键词至少两个字，太短会把整个池捞出来");
      const limit = Math.min(30, Math.max(1, Math.round(Number(p.limit) || 15)));
      const hits = d.store.searchMessages(pool.pool_id, kw, limit);
      const span = d.store.poolSpan(pool.pool_id);
      if (!hits.length) return txt(`「${kw}」在 ${span.total} 条记录里没找到`, { hits: 0, total: span.total });
      const more = span.total > 0 && hits.length >= limit ? "（可能还有更早的，把 limit 调大或换个更具体的词）" : "";
      return txt(
        `「${kw}」命中 ${hits.length} 条${more}，共 ${span.total} 条记录：\n${hits.map((m) => fmtMsg(m)).join("\n")}`,
        { hits: hits.length, total: span.total },
      );
    },
  });






  // 读本地图片进上下文。只允许两个沙箱目录：data/media/（聊天里收到的图）和 data/inbox/（手动放的）。
  // rabbit-bot 收的是任意飞书用户消息，一句提示注入就能让它读走 ~/.ssh 或凭据文件，所以路径必须锁死在这两个根下。
  const mediaDir = path.join(d.cfg.dataDir, "media");
  const inboxDir = path.join(d.cfg.dataDir, "inbox");
  const viewCacheDir = path.join(d.cfg.dataDir, "cache");

  /** "media/x.jpg" / "inbox/x.png" / 裸文件名 → 两个根下的真实文件；越界一律返回 null */
  const resolveImage = (p: string): string | null => {
    const bare = p.replace(/^(media|inbox)[/\\]/, "");
    for (const root of [inboxDir, mediaDir]) {
      for (const rel of [p, bare]) {
        const abs = path.resolve(root, rel);
        if (!abs.startsWith(root + path.sep)) continue;
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
      }
    }
    return null;
  };

  const viewImage = defineTool({
    name: "view_image",
    label: "view_image",
    executionMode: "sequential",
    description: "把一张图片加载进上下文（长边压到 1024）。path 用 list_images 给出的名字，如 media/om_xxx.jpg、inbox/shot.png。一次只加载一张。",
    parameters: Type.Object({ path: Type.String({ description: "media/… 或 inbox/… 开头的文件名" }) }),
    async execute(_id, p) {
      const abs = resolveImage(p.path);
      if (!abs) return txt(`没有这张图：${p.path}（先用 list_images 看看有哪些）`, { ok: false });
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

  // 列能看的图（分页）。它看不到文件系统，没这个就不知道 view_image 该传什么名字。

  // 联网搜索：DeepSeek 官方搜索接口（POST /v1/tools/search，自研搜索引擎）。
  // 只返回标题/站点/日期/摘要/链接，正文按需（with_content）——摘要 600-800 字够模型读了。
  const webSearch = defineTool({
    name: "web_search",
    label: "web_search",
    executionMode: "sequential",
    description:
      "联网搜索，查实时信息：新闻、价格、发售日、天气、版本号、某个说法真假、某人的近况。返回标题、站点、日期、摘要和链接。别用它替代记忆或闲聊。",
    parameters: Type.Object({
      query: Type.String({ description: "搜索词，≤128 字，支持 site:、-site:、引号等语法" }),
      count: Type.Optional(Type.Number({ description: "返回条数 1-10，默认 6" })),
      with_content: Type.Optional(Type.Boolean({ description: "true 时额外取网页正文，慢，只在摘要不够时用" })),
    }),
    async execute(_id, p) {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) return txt("搜索不可用：进程里没有 DEEPSEEK_API_KEY", { ok: false });
      const query = String(p.query || "").trim().slice(0, 128);
      if (!query) return txt("搜索词不能为空", { ok: false });
      const count = Math.min(10, Math.max(1, Math.round(Number(p.count) || 6)));
      const withContent = p.with_content === true;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch("https://api.deepseek.com/v1/tools/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, count, need_content: withContent }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return txt(`搜索失败：HTTP ${res.status} ${body.slice(0, 200)}`, { ok: false, status: res.status });
        }
        const data = (await res.json()) as { results?: any[] };
        const rs = (data.results || []).filter((r) => r && r.title && r.url);
        if (!rs.length) return txt(`「${query}」没搜到结果`, { ok: true, hits: 0 });
        const lines = rs.map((r, i) => {
          const meta = [
            r.site_name,
            r.date ? String(r.date).slice(0, 10) : "",
            typeof r.authority === "number" && r.authority >= 3 ? "权威" : "",
          ].filter(Boolean).join(" · ");
          const raw = withContent && r.content ? r.content : r.summary || r.snippet || "";
          const body = String(raw).replace(/\s+/g, " ").trim().slice(0, withContent ? 1500 : 500);
          return `${i + 1}. ${r.title}${meta ? `（${meta}）` : ""}\n${r.url}${body ? `\n${body}` : ""}`;
        });
        return txt(`「${query}」搜到 ${rs.length} 条：\n\n${lines.join("\n\n")}`, { ok: true, hits: rs.length });
      } catch (e) {
        const err = e as Error;
        return txt(`搜索失败：${err.name === "AbortError" ? "超时 15s" : err.message}`, { ok: false });
      } finally {
        clearTimeout(timer);
      }
    },
  });

  // 抓全文：DeepSeek 官方 Fetch 接口（POST /v1/tools/fetch），返回标题 + Markdown 正文。
  const webFetch = defineTool({
    name: "web_fetch",
    label: "web_fetch",
    executionMode: "sequential",
    description: "打开一个网页，返回标题和 Markdown 正文。web_search 只给摘要，要读全文（文章、文档、公告、帖子）就用这个。一次抓一个链接。",
    parameters: Type.Object({
      url: Type.String({ description: "http/https 链接，需含 host" }),
    }),
    async execute(_id, p) {
      const key = process.env.DEEPSEEK_API_KEY;
      if (!key) return txt("抓取不可用：进程里没有 DEEPSEEK_API_KEY", { ok: false });
      const url = String(p.url || "").trim();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return txt("链接不合法：不是完整 URL", { ok: false });
      }
      if (!/^https?:$/.test(parsed.protocol)) return txt("链接不合法：只支持 http/https", { ok: false });
      if (parsed.username || parsed.password) return txt("链接不合法：不能带用户名或密码", { ok: false });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch("https://api.deepseek.com/v1/tools/fetch", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ url: parsed.toString() }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return txt(`抓取失败：HTTP ${res.status} ${body.slice(0, 200)}`, { ok: false, status: res.status });
        }
        const data = (await res.json()) as { title?: string; content?: string };
        const body = String(data.content || "").replace(/\n{3,}/g, "\n\n").trim();
        if (!body) return txt(`页面没有正文（${parsed.toString()}）`, { ok: true, chars: 0 });
        const cut = body.length > 6000;
        return txt(
          `${data.title ? `标题：${data.title}\n` : ""}${parsed.toString()}\n\n${body.slice(0, 6000)}${cut ? "\n\n…（正文已截断，长文只读了前面一部分）" : ""}`,
          { ok: true, chars: body.length, truncated: cut },
        );
      } catch (e) {
        const err = e as Error;
        return txt(`抓取失败：${err.name === "AbortError" ? "超时 20s" : err.message}`, { ok: false });
      } finally {
        clearTimeout(timer);
      }
    },
  });

  // 沙盒文件区：根目录固定（cfg.sandbox.dir），只收相对路径，越界/符号链逃逸一律拒绝。
  // codemode 的 VM 里没有 fs，模型只能用这三个工具碰文件；它们也是「沙盒根目录」唯一的实现方式。
  const sbox = () =>
    createSandboxFs({
      root: d.cfg.sandbox.dir,
      maxFileBytes: d.cfg.sandbox.maxFileBytes,
      maxFiles: d.cfg.sandbox.maxFiles,
      maxReadChars: d.cfg.sandbox.maxReadChars,
    });
  const sboxErr = (e: unknown) => txt((e as Error).message, { ok: false });




  // 沙盒 shell：命令跑在隔离容器里（无网 / 根只读 / 只有 /work 可写），宿主机的路径在容器里不存在。


  const listImages = defineTool({
    name: "list_images",
    label: "list_images",
    executionMode: "sequential",
    description: "列出能看的图片：media/（聊天里收到的，带消息号和尺寸）和 inbox/（手动放的），按时间从新到旧，分页。看下一页加 page。",
    parameters: Type.Object({
      source: Type.Optional(Type.String({ description: "media / inbox / all，默认 all" })),
      page: Type.Optional(Type.Number({ description: "第几页，从 1 开始，默认 1" })),
      page_size: Type.Optional(Type.Number({ description: "每页条数，默认 20，最多 50" })),
    }),
    async execute(_id, p) {
      const page = Math.max(1, Math.floor(p.page ?? 1));
      const size = Math.min(50, Math.max(1, Math.floor(p.page_size ?? 20)));
      const src = String(p.source ?? "all").toLowerCase();
      const items: { label: string; mtime: number }[] = [];
      if (src === "media" || src === "all") {
        // 从 DB 取（view_image 的压缩缓存写在 data/cache/，不会混进来）
        const rows = d.store.db.prepare("select seq, ts, attachment from messages where attachment is not null order by seq desc limit 500").all() as any[];
        for (const r of rows) {
          let a: any;
          try { a = JSON.parse(r.attachment); } catch { continue; }
          if (!a?.path) continue;
          items.push({ label: `media/${path.basename(a.path)} · ${a.width}×${a.height} · ${(a.bytes / 1024).toFixed(0)}KB · 消息#${r.seq} · ${fmtLocal(r.ts)}`, mtime: r.ts });
        }
      }
      if (src === "inbox" || src === "all") {
        try {
          for (const e of fs.readdirSync(inboxDir, { withFileTypes: true })) {
            if (!e.isFile()) continue;
            const st = fs.statSync(path.join(inboxDir, e.name));
            items.push({ label: `inbox/${e.name} · ${(st.size / 1024).toFixed(0)}KB · ${fmtLocal(st.mtimeMs)}`, mtime: st.mtimeMs });
          }
        } catch { /* 没有 inbox 目录就当空 */ }
      }
      items.sort((a, b) => b.mtime - a.mtime);
      const total = items.length;
      if (!total) return txt("还没有能看的图片（聊天里发过的图和 data/inbox/ 里放的文件都会出现在这里）", { total: 0 });
      const pages = Math.ceil(total / size);
      const slice = items.slice((page - 1) * size, page * size);
      const more = page < pages ? `\n（还有下一页：page=${page + 1}）` : "";
      return txt(`共 ${total} 张，第 ${page}/${pages} 页\n${slice.map((i) => i.label).join("\n") || "（本页为空）"}${more}`, { total, page, pages });
    },
  });

  /**
   * 通用 CLI 通道：低频操作（计划、记忆、沙盒文件、图片列表、联网）走命令行，
   * 不再各自占一个工具 schema。一个工具替代七八个，prompt 里省下的是每次调用都要付的钱。
   *
   * 只认白名单首命令，且不起 shell（execFile 逐参数传），模型没法拼出 `; rm -rf`。
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
      "跑 rabbit-bot 的命令行（JSON 输出）。用于：记/查计划（plan list|add|update）、记/查长期记忆（mem add|search）、"
      + "沙盒文件（sb list|read|write|run）、列图片（img list|view）、翻旧消息（pool list|read|search）、联网（web search|fetch）。"
      + "args 传完整参数串，例如 args=\"plan list\"、args=\"mem add --user u1 --content 他周一要交报告 --pool p1\"。不确定就 args=\"--help\"。",
    parameters: Type.Object({ args: Type.String({ description: "命令行参数串，不含开头的 rb" }) }),
    async execute(_id, p) {
      const parts = splitArgs(String(p.args ?? ""));
      const head = parts[0] ?? "";
      const allowed = ["pool", "plan", "mem", "img", "sb", "web", "--help"];
      if (!allowed.includes(head)) {
        return txt(`不支持的子命令「${head}」。可用：${allowed.join(" / ")}；args="--help" 看全部用法。`, { ok: false });
      }
      try {
        // --db 指向本进程用的同一个库：否则 CLI 会去开默认库，测试里写的和读的不是一个地方
        const { stdout } = await execFileAsync("npx", ["tsx", "src/cli.ts", ...parts, "--db", d.store.file, "--now", String(d.now())], {
          cwd: APP_ROOT, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: process.env,
        });
        return txt(stdout.trim() || "（没有输出）", { ok: true });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        const body = (err.stdout || "").trim() || err.message;
        return txt(`命令失败：${body.slice(0, 800)}`, { ok: false });
      }
    },
  });

  return [send, staySilent, readPool, searchMessages, listImages, viewImage, webSearch, webFetch, rb];
}
