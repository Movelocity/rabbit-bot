/**
 * rb —— rabbit-bot 的命令行入口。
 *
 * 设计原则：
 * 1. 薄壳：所有逻辑都在 src/core / src/agent 里，这里只做参数解析和输出，不重新实现一遍规则。
 *    所以同一个能力，agent 走工具、人走 CLI、别的 agent 走 shell，三边行为一定一致。
 * 2. 输出默认是 JSON（{ok, data} / {ok:false, error}）：给程序读的东西不该是给人看的格式。
 *    --human 只是调试时方便肉眼。
 * 3. 只读写库和外部 API，不碰 hub / 唤醒循环——那些依赖正在跑的进程状态，CLI 碰了就会有两份真相。
 *
 *   rb pool list
 *   rb pool read p1 --limit 20
 *   rb pool search "火锅" --pool p1
 *   rb plan list / add / update
 *   rb mem add / search
 *   rb img list / view
 *   rb sb list / read / write / run
 *   rb web search / fetch
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "./core/db.ts";
import { loadConfig } from "./config.ts";
import { validateSchedule } from "./core/plans.ts";
import { parseIsoInTz, fmtLocal } from "./core/time.ts";
import { fmtMsg, poolLabel } from "./agent/prompt.ts";
import { createSandboxFs } from "./core/sandbox-fs.ts";
import { runInSandbox } from "./core/sandbox-shell.ts";
import type { MemoryScope } from "./types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

type Flags = Record<string, string | boolean | undefined>;
interface Parsed { pos: string[]; flags: Flags }

export function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[body] = next; i++; }
    else flags[body] = true;
  }
  return { pos, flags };
}

const str = (f: Flags, k: string): string | undefined => {
  const v = f[k];
  return v === undefined || v === true ? undefined : String(v);
};
const num = (f: Flags, k: string): number | undefined => {
  const v = str(f, k);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (f: Flags, k: string): boolean => f[k] === true || f[k] === "true" || f[k] === "1";

const HELP = `rb — rabbit-bot 命令行

  pool list                     列出所有池
  pool read <pool> [--limit 15] [--before-seq N]
                                读池的历史（不动未读游标）
  pool search <关键词> --pool <p> [--limit 15]
                                按关键词翻旧账
  plan list [--status pending|done|cancelled]
  plan add --title <t> --kind once|cron|none [--when <值>] [--pool <p>]
           [--anchor L0|L1|L2] [--why <一句话>] [--expires <ISO>]
  plan update <id> --status pending|done|cancelled
  mem add --user <uid> --content <文本> --pool <来源池> [--kind fact|topic] [--scope ...]
  mem search --user <uid> --pool <p> [--limit 20]
  img list [--source media|inbox|all] [--page 1] [--size 20]
  img view <path>               给出真实路径与尺寸（读图本身仍由模型侧的 view_image 做）
  sb list [path]                沙盒目录（看一层）
  sb read <path>
  sb write <path> --content <文本> | --from-file <本地文件>
  sb run <命令> [--timeout 10]
  web search <查询> [--count 6] [--content]
  web fetch <url>

  全局：--db <路径>  --human（人读格式）  --help

输出约定：成功 {"ok":true,"data":…}，失败 {"ok":false,"error":"…"}，退出码 0 / 1。`;

function openStore(flags: Flags): Store {
  const dbPath = str(flags, "db") ?? path.join(HERE, "..", "data", "rabbit-bot.db");
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);
  return new Store(dbPath);
}

function mustPool(store: Store, ref: string | undefined) {
  if (!ref) throw new Error("缺少 --pool（先用 rb pool list 看有哪些）");
  const pool = store.resolvePool(ref);
  if (!pool) throw new Error(`未知的池 ${ref}`);
  return pool;
}

// ---------- pool ----------

function cmdPool(store: Store, { pos, flags }: Parsed): unknown {
  const sub = pos[0];
  if (sub === "list") {
    const pools = store.listPools();
    return pools.map((p) => ({
      alias: store.poolAlias(p.pool_id),
      pool_id: p.pool_id,
      kind: p.kind,
      title: p.title ?? "",
      last_msg_at: p.last_msg_at || null,
      last_msg_local: p.last_msg_at ? fmtLocal(p.last_msg_at) : null,
      total: store.poolSpan(p.pool_id).total,
    }));
  }
  if (sub === "read") {
    const pool = mustPool(store, pos[1] ?? str(flags, "pool"));
    const limit = Math.min(50, Math.max(1, num(flags, "limit") ?? 15));
    const before = num(flags, "before-seq");
    const msgs = store.recentMessages(pool.pool_id, limit, before ? before - 1 : undefined);
    const span = store.poolSpan(pool.pool_id);
    return {
      pool: store.poolAlias(pool.pool_id), total: span.total,
      oldest_seq: span.first?.seq ?? null,
      messages: msgs.map((m) => ({ seq: m.seq, ts: m.ts, local: fmtLocal(m.ts), from_self: !!m.from_self, sender: m.sender_name, text: m.text })),
      text: msgs.map((m) => fmtMsg(m)).join("\n"),
    };
  }
  if (sub === "search") {
    const kw = (pos[1] ?? str(flags, "keyword") ?? "").trim().slice(0, 30);
    if (kw.length < 2) throw new Error("关键词至少两个字");
    const pool = mustPool(store, str(flags, "pool") ?? pos[2]);
    const limit = Math.min(30, Math.max(1, num(flags, "limit") ?? 15));
    const hits = store.searchMessages(pool.pool_id, kw, limit);
    return {
      pool: store.poolAlias(pool.pool_id), keyword: kw, hits: hits.length,
      messages: hits.map((m) => ({ seq: m.seq, local: fmtLocal(m.ts), from_self: !!m.from_self, sender: m.sender_name, text: m.text })),
      text: hits.map((m) => fmtMsg(m)).join("\n"),
    };
  }
  throw new Error(`pool 的子命令：list | read | search`);
}

// ---------- plan ----------

function cmdPlan(store: Store, cfg: ReturnType<typeof loadConfig>, { pos, flags }: Parsed): unknown {
  // --now 只给测试用：模拟器的时间是假的，CLI 不能拿真实时钟去判「这个时间过没过」
  const now = num(flags, "now") ?? Date.now();
  const sub = pos[0];
  if (sub === "list") {
    const status = (str(flags, "status") ?? "pending") as "pending" | "done" | "cancelled";
    const ps = store.listPlans(status);
    return ps.map((p: any) => ({
      id: p.id, title: p.title, status: p.status, kind: p.schedule_kind, schedule: p.schedule ?? null,
      anchor: p.anchor_kind ?? null, pool: p.pool_id ? store.poolAlias(p.pool_id) : null,
      next_fire_local: p.next_fire_at ? fmtLocal(p.next_fire_at) : null, why: p.why ?? null,
    }));
  }
  if (sub === "add") {
    const title = str(flags, "title");
    if (!title) throw new Error("缺少 --title");
    const kind = (str(flags, "kind") ?? "none") as "once" | "cron" | "none";
    const v = validateSchedule({ kind, value: str(flags, "when") }, now, cfg.timezone);
    if (!v.ok) throw new Error(`计划格式错误：${v.error}`);
    let expires: number | null = null;
    if (str(flags, "expires")) {
      expires = parseIsoInTz(String(str(flags, "expires")), cfg.timezone);
      if (expires === null) throw new Error("--expires 不是合法 ISO 时间");
    }
    const pool = str(flags, "pool") ? mustPool(store, str(flags, "pool")) : undefined;
    const plan = store.insertPlan({
      title, content: str(flags, "content") ?? "", pool_id: pool?.pool_id ?? null,
      schedule_kind: v.kind, schedule: v.schedule, expires_at: expires,
      anchor_kind: (str(flags, "anchor") as any) ?? null, why: str(flags, "why") ?? null,
    });
    return { id: plan.id, first_fire_local: v.firstFire ? fmtLocal(v.firstFire) : null };
  }
  if (sub === "update") {
    const id = Number(pos[1] ?? str(flags, "id"));
    const status = str(flags, "status") as "pending" | "done" | "cancelled" | undefined;
    if (!id || !status) throw new Error("用法：rb plan update <id> --status done");
    if (!store.setPlanStatus(id, status)) throw new Error(`没有计划 #${id}`);
    return { id, status };
  }
  throw new Error("plan 的子命令：list | add | update");
}

// ---------- mem ----------

function cmdMem(store: Store, { pos, flags }: Parsed): unknown {
  const sub = pos[0];
  if (sub === "add") {
    const user = str(flags, "user");
    const content = str(flags, "content");
    if (!user || !content) throw new Error("缺少 --user 或 --content");
    const pool = mustPool(store, str(flags, "pool"));
    const scope: MemoryScope = (str(flags, "scope") as MemoryScope) ?? (pool.kind === "private" ? "private" : "group");
    const id = store.addMemory({
      user_id: user, kind: (str(flags, "kind") as any) ?? undefined, content,
      source_pool_id: pool.pool_id, source_kind: pool.kind, scope,
    });
    return { id, scope };
  }
  if (sub === "search") {
    const user = str(flags, "user");
    if (!user) throw new Error("缺少 --user");
    const pool = mustPool(store, str(flags, "pool"));
    const limit = num(flags, "limit") ?? 20;
    const ms = store.visibleMemories(user, pool, limit) as any[];
    return ms.map((m) => ({ id: m.id, kind: m.kind, scope: m.scope, content: m.content }));
  }
  throw new Error("mem 的子命令：add | search");
}

// ---------- img ----------

function cmdImg(store: Store, cfg: ReturnType<typeof loadConfig>, { pos, flags }: Parsed): unknown {
  const sub = pos[0];
  const mediaDir = path.join(cfg.dataDir, "media");
  const inboxDir = path.join(cfg.dataDir, "inbox");
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
  if (sub === "view") {
    const target = pos[1] ?? str(flags, "path");
    if (!target) throw new Error("缺少图片路径");
    const abs = resolveImage(target);
    if (!abs) throw new Error(`没有这张图：${target}`);
    const st = fs.statSync(abs);
    return { path: abs, bytes: st.size, exists: true };
  }
  if (sub !== "list") throw new Error("img 的子命令：list | view");
  const page = Math.max(1, Math.floor(num(flags, "page") ?? 1));
  const size = Math.min(50, Math.max(1, Math.floor(num(flags, "size") ?? 20)));
  const src = (str(flags, "source") ?? "all").toLowerCase();
  const items: { name: string; kind: string; bytes: number; mtime: number; note?: string }[] = [];
  if (src === "media" || src === "all") {
    const rows = store.db.prepare("select seq, ts, attachment from messages where attachment is not null order by seq desc limit 500").all() as any[];
    for (const r of rows) {
      let a: any;
      try { a = JSON.parse(r.attachment); } catch { continue; }
      if (!a?.path) continue;
      items.push({ name: `media/${path.basename(a.path)}`, kind: "media", bytes: a.bytes ?? 0, mtime: r.ts, note: `${a.width}×${a.height} 消息#${r.seq}` });
    }
  }
  if (src === "inbox" || src === "all") {
    try {
      for (const e of fs.readdirSync(inboxDir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        const st = fs.statSync(path.join(inboxDir, e.name));
        items.push({ name: `inbox/${e.name}`, kind: "inbox", bytes: st.size, mtime: st.mtimeMs });
      }
    } catch { /* 没有 inbox 就当空 */ }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  const pages = Math.max(1, Math.ceil(items.length / size));
  return {
    total: items.length, page, pages,
    items: items.slice((page - 1) * size, page * size).map((i) => ({ ...i, local: fmtLocal(i.mtime) })),
  };
}

// ---------- sandbox ----------

async function cmdSandbox(cfg: ReturnType<typeof loadConfig>, { pos, flags }: Parsed): Promise<unknown> {
  const sc = cfg.sandbox;
  const sbox = () => createSandboxFs({
    root: sc.dir, maxFileBytes: sc.maxFileBytes, maxFiles: sc.maxFiles, maxReadChars: sc.maxReadChars,
  });
  const sub = pos[0];
  if (sub === "list") return sbox().list(pos[1] ?? "");
  if (sub === "read") {
    if (!pos[1]) throw new Error("缺少路径");
    return { path: pos[1], content: sbox().read(pos[1]) };
  }
  if (sub === "write") {
    if (!pos[1]) throw new Error("缺少路径");
    const fromFile = str(flags, "from-file");
    const content = fromFile ? fs.readFileSync(fromFile, "utf8") : str(flags, "content");
    if (content === undefined) throw new Error("缺少 --content 或 --from-file");
    return { path: pos[1], bytes: sbox().write(pos[1], content) };
  }
  if (sub === "run") {
    if (!sc.shell.enabled) throw new Error("沙盒 shell 没开");
    const cmd = pos.slice(1).join(" ") || str(flags, "cmd");
    if (!cmd) throw new Error("缺少命令");
    const secs = Math.min(30, Math.max(1, Math.floor(num(flags, "timeout") ?? sc.shell.timeoutMs / 1000)));
    const r = await runInSandbox(cmd, {
      container: sc.shell.container, image: sc.shell.image, network: sc.shell.network,
      workspace: sc.dir, timeoutMs: secs * 1000, maxOutputChars: sc.shell.maxOutputChars,
    });
    return { code: r.code, ok: r.ok, output: r.output };
  }
  throw new Error("sb 的子命令：list | read | write | run");
}

// ---------- web ----------

/** pm2 里的进程有这些变量，交互 shell 没有：从仓库外的 env 文件补 */
function loadEnvFile(): void {
  const f = path.join(process.env.HOME ?? "", ".config", "rabbit-bot", "env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}

async function cmdWeb({ pos, flags }: Parsed): Promise<unknown> {
  loadEnvFile();
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("没有 DEEPSEEK_API_KEY，联网不可用");
  const sub = pos[0];
  const auth = { "content-type": "application/json", authorization: `Bearer ${key}` };
  if (sub === "search") {
    const query = (pos[1] ?? str(flags, "query") ?? "").trim().slice(0, 128);
    if (!query) throw new Error("缺少查询词");
    const count = Math.min(10, Math.max(1, num(flags, "count") ?? 6));
    const res = await fetch("https://api.deepseek.com/v1/tools/search", {
      method: "POST", headers: auth,
      body: JSON.stringify({ query, count, need_content: bool(flags, "content") }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);
    const data = (await res.json()) as { results?: any[] };
    return (data.results || []).filter((r) => r?.title && r?.url).map((r) => ({
      title: r.title, url: r.url, site: r.site_name ?? null, date: r.date ?? null,
      summary: String(r.content ?? r.summary ?? r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
    }));
  }
  if (sub === "fetch") {
    const raw = pos[1] ?? str(flags, "url");
    if (!raw) throw new Error("缺少 url");
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) throw new Error("只支持 http/https");
    const res = await fetch("https://api.deepseek.com/v1/tools/fetch", {
      method: "POST", headers: auth, body: JSON.stringify({ url: u.toString() }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`);
    const data = (await res.json()) as { title?: string; content?: string };
    const body = String(data.content ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return { url: u.toString(), title: data.title ?? null, chars: body.length, truncated: body.length > 6000, content: body.slice(0, 6000) };
  }
  throw new Error("web 的子命令：search | fetch");
}

// ---------- 人读格式 ----------

function humanize(cmd: string[], data: unknown): string {
  const d = data as any;
  if (cmd[0] === "pool" && cmd[1] === "list" && Array.isArray(d))
    return d.map((p: any) => `${p.alias}  ${p.kind}  ${p.title || "-"}  最后 ${p.last_msg_local ?? "-"}  ${p.total} 条`).join("\n") || "（没有池）";
  if (cmd[0] === "pool" && (cmd[1] === "read" || cmd[1] === "search")) return d.text || "（无消息）";
  if (cmd[0] === "plan" && cmd[1] === "list" && Array.isArray(d))
    return d.map((p: any) => `#${p.id}「${p.title}」${p.kind}${p.schedule ? " " + p.schedule : ""}${p.pool ? " " + p.pool : ""}`).join("\n") || "（无）";
  if (cmd[0] === "mem" && cmd[1] === "search" && Array.isArray(d))
    return d.map((m: any) => `#${m.id}[${m.kind}] ${m.content}`).join("\n") || "（无）";
  if (cmd[0] === "img" && cmd[1] === "list")
    return `共 ${d.total} 张，第 ${d.page}/${d.pages} 页\n` + (d.items.map((i: any) => `${i.name} · ${(i.bytes / 1024).toFixed(0)}KB · ${i.local}${i.note ? " · " + i.note : ""}`).join("\n") || "（本页空）");
  if (cmd[0] === "sb" && cmd[1] === "list")
    return (d as any[]).map((e: any) => (e.kind === "dir" ? `${e.path}/` : `${e.path} · ${e.bytes}B`)).join("\n") || "（空目录）";
  if (cmd[0] === "sb" && cmd[1] === "read") return d.content;
  if (cmd[0] === "sb" && cmd[1] === "run") return (d.ok ? "" : `退出码 ${d.code}\n`) + (d.output || "（没有输出）");
  if (cmd[0] === "web" && cmd[1] === "search" && Array.isArray(d))
    return d.map((r: any, i: number) => `${i + 1}. ${r.title}${r.site ? `（${r.site}）` : ""}\n${r.url}\n${r.summary}`).join("\n\n") || "（没搜到）";
  if (cmd[0] === "web" && cmd[1] === "fetch") return `${d.title ? `标题：${d.title}\n` : ""}${d.url}\n\n${d.content}`;
  return JSON.stringify(data, null, 2);
}

export async function run(argv: string[]): Promise<number> {
  const human = argv.includes("--human");
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  const parsed = parseArgs(argv);
  const { pos, flags } = parsed;
  const cmd = [pos[0], pos[1]];
  // 子命令拿到的是 pos.slice(1)：pos[0] 是命令名本身
  const sub = { pos: pos.slice(1), flags };
  let store: Store | null = null;
  try {
    const cfg = loadConfig({});
    if (pos[0] === "web") {
      const data = await cmdWeb(sub);
      return emit(data, human, cmd);
    }
    if (pos[0] === "sb") {
      const data = await cmdSandbox(cfg, sub);
      return emit(data, human, cmd);
    }
    store = openStore(flags);
    let data: unknown;
    if (pos[0] === "pool") data = cmdPool(store, sub);
    else if (pos[0] === "plan") data = cmdPlan(store, cfg, sub);
    else if (pos[0] === "mem") data = cmdMem(store, sub);
    else if (pos[0] === "img") data = cmdImg(store, cfg, sub);
    else throw new Error(`不认识的命令：${pos[0] ?? "(空)"}。rb --help 看用法`);
    return emit(data, human, cmd);
  } catch (e) {
    const msg = (e as Error).message;
    if (human) console.error(`✗ ${msg}`);
    else console.log(JSON.stringify({ ok: false, error: msg }));
    return 1;
  } finally {
    store?.close();
  }
}

function emit(data: unknown, human: boolean, cmd: string[]): number {
  if (human) console.log(humanize(cmd, data));
  else console.log(JSON.stringify({ ok: true, data }, null, 2));
  return 0;
}

/** 供 bin/rb 调用；被 import 时不自动执行 */
export const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) run(process.argv.slice(2)).then((c) => process.exit(c));
