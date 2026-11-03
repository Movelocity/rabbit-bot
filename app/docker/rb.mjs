#!/usr/bin/env node
/**
 * 沙盒内的 rb 客户端。
 *
 * 业务数据（池/计划/记忆/图片/联网/技能）走宿主 REST API，用 RB_API_URL + RB_API_TOKEN；
 * 文件和 shell 直接操作当前沙盒（/work），不再绕宿主。
 *
 * 输出契约和旧 CLI 一致：成功 {ok:true,data} 退 0；失败 {ok:false,error} 退 1。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const API = process.env.RB_API_URL;
const TOKEN = process.env.RB_API_TOKEN;
const NOW = Number(process.env.RB_NOW) || undefined;
const CWD = process.cwd();

function parse(argv) {
  const pos = [];
  const flags = {};
  const dd = argv.indexOf("--");
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = head[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[body] = next; i++; }
    else flags[body] = true;
  }
  if (rest.length) pos.push(...rest);
  return { pos, flags };
}

const str = (f, k) => (f[k] === undefined || f[k] === true ? undefined : String(f[k]));
const num = (f, k) => {
  const v = str(f, k);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (f, k) => f[k] === true || f[k] === "true" || f[k] === "1";

function needApi() {
  if (!API || !TOKEN) throw new Error("缺少 RB_API_URL / RB_API_TOKEN（宿主没注入，或 API 没开）");
  return { API, TOKEN };
}

async function api(method, p, { query, body } = {}) {
  const { API: base, TOKEN: token } = needApi();
  const u = new URL(base + p);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(u, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`API 返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
    if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function safePath(p) {
  if (!p) throw new Error("缺少路径");
  if (path.isAbsolute(p)) throw new Error("路径必须是相对的（根目录就是 /work）");
  const abs = path.resolve(CWD, p);
  if (abs !== CWD && !abs.startsWith(CWD + path.sep)) throw new Error(`路径越界：${p}`);
  return abs;
}

function listDir(rel) {
  const abs = rel ? safePath(rel) : CWD;
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error(`不是目录：${rel}`);
  return fs.readdirSync(abs, { withFileTypes: true })
    .map((e) => {
      const full = path.join(abs, e.name);
      const s = fs.statSync(full);
      return {
        name: rel ? `${rel.replace(/\/$/, "")}/${e.name}` : e.name,
        kind: e.isDirectory() ? "dir" : "file",
        bytes: e.isDirectory() ? 0 : s.size,
        mtime: Math.round(s.mtimeMs),
      };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
}

function runLocal(cmd) {
  const r = spawnSync("sh", ["-lc", cmd], { cwd: CWD, encoding: "utf8", timeout: 30_000, maxBuffer: 1 << 20 });
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL";
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const body = timedOut ? `${output}${output ? "\n" : ""}（超过 30 秒被终止）` : output;
  return { code: r.status ?? (timedOut ? 137 : 1), ok: r.status === 0 && !timedOut, output: body };
}

const HELP = `用法：rb <命令> [参数…]

业务（走宿主 API）：
  pool-list
  pool-read <池> [--limit 15] [--before-seq N]
  pool-search <关键词> --pool <池> [--limit 20] [--only-other|--only-self]
  plan-list [--status pending|done|cancelled]
  plan-add --title T [--kind once|cron|none] [--when V] [--pool P] [--anchor L0|L1|L2] [--why W] [--expires ISO]
  plan-update <id> --status pending|done|cancelled
  mem-add --user U --content C --pool P [--kind fact|plan|alias] [--scope pool|private|group|all]
          [--from ISO] [--until ISO] [--supersede <旧记忆id>]
  mem-search --user U --pool P [--limit 20] [--at ISO] [--all]
  img-list [--source media|inbox|all] [--page 1] [--size 20]
  img-get <media/…|inbox/…> [--out 文件名]
  web-search <查询> [--count 6] [--content]
  web-fetch <url>
  skills

沙盒（直接操作 /work）：
  sb list [子目录]
  sb read <相对路径>
  sb write <相对路径> --content "…"
  sb run "命令"`;

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") return console.log(HELP);

  switch (cmd) {
    case "pool-list":
      return api("GET", "/v1/pools");
    case "pool-read":
      return api("GET", `/v1/pools/${encodeURIComponent(pos[1] ?? str(flags, "pool") ?? "")}/messages`, {
        query: { limit: num(flags, "limit"), before_seq: num(flags, "before-seq") },
      });
    case "pool-search":
      return api("GET", `/v1/pools/${encodeURIComponent(str(flags, "pool") ?? pos[2] ?? "")}/search`, {
        query: {
          q: pos[1] ?? str(flags, "keyword"), limit: num(flags, "limit"),
          only: flags["only-other"] ? "other" : flags["only-self"] ? "self" : undefined,
        },
      });
    case "plan-list":
      return api("GET", "/v1/plans", { query: { status: str(flags, "status") ?? "pending" } });
    case "plan-add":
      return api("POST", "/v1/plans", {
        body: {
          title: str(flags, "title"),
          content: str(flags, "content"),
          kind: str(flags, "kind") ?? "none",
          when: str(flags, "when"),
          pool: str(flags, "pool"),
          anchor: str(flags, "anchor"),
          why: str(flags, "why"),
          expires: str(flags, "expires"),
          now: NOW,
        },
      });
    case "plan-update":
      return api("PATCH", `/v1/plans/${encodeURIComponent(pos[1] ?? str(flags, "id") ?? "")}`, {
        body: { status: str(flags, "status") },
      });
    case "mem-add":
      return api("POST", "/v1/memories", {
        body: {
          user: str(flags, "user"),
          content: str(flags, "content"),
          pool: str(flags, "pool"),
          kind: str(flags, "kind"),
          scope: str(flags, "scope"),
          from: str(flags, "from"),
          until: str(flags, "until"),
          supersede: str(flags, "supersede"),
        },
      });
    case "mem-search":
      return api("GET", "/v1/memories", {
        query: {
          user: str(flags, "user"), pool: str(flags, "pool"), limit: num(flags, "limit"),
          at: str(flags, "at"), all: flags.all ? "1" : undefined,
        },
      });
    case "img-list":
      return api("GET", "/v1/images", {
        query: { source: str(flags, "source"), page: num(flags, "page"), size: num(flags, "size") },
      });
    case "img-get": {
      const target = pos[1] ?? str(flags, "path");
      const { API: base, TOKEN: token } = needApi();
      const u = new URL(base + "/v1/images/file");
      u.searchParams.set("path", target ?? "");
      const res = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const text = await res.text();
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(text).error ?? msg; } catch { /* 非 JSON */ }
        throw new Error(msg);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const out = str(flags, "out") ?? path.basename(target ?? "image");
      const abs = safePath(out);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      return { path: out, bytes: buf.length };
    }
    case "web-search":
      return api("GET", "/v1/web/search", {
        query: { q: pos[1] ?? str(flags, "query"), count: num(flags, "count"), content: bool(flags, "content") ? "1" : undefined },
      });
    case "web-fetch":
      return api("POST", "/v1/web/fetch", { body: { url: pos[1] ?? str(flags, "url") } });
    case "skills":
      return api("GET", "/v1/skills");
    case "sb": {
      const sub = pos[1];
      if (sub === "list") return listDir(pos[2] ?? "");
      if (sub === "read") {
        const abs = safePath(pos[2]);
        return { path: pos[2], content: fs.readFileSync(abs, "utf8") };
      }
      if (sub === "write") {
        const abs = safePath(pos[2]);
        const content = str(flags, "content");
        if (content === undefined) throw new Error("缺少 --content");
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        return { path: pos[2], bytes: Buffer.byteLength(content) };
      }
      if (sub === "run") {
        const cmdline = pos.slice(2).join(" ") || str(flags, "cmd");
        if (!cmdline) throw new Error("缺少命令");
        return runLocal(cmdline);
      }
      throw new Error("子命令：list | read | write | run");
    }
    default:
      throw new Error(`没有这个命令「${cmd}」。用 rb help 看清单`);
  }
}

main().then(
  (data) => {
    if (data !== undefined) console.log(JSON.stringify({ ok: true, data }, null, 2));
    process.exit(0);
  },
  (e) => {
    console.log(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
    process.exit(1);
  },
);
