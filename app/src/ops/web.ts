/** 联网搜索 / 抓正文（DeepSeek 官方接口）。CLI（scripts/web-*.ts）和 API 都走这里。 */
import fs from "node:fs";
import path from "node:path";

/** pm2 里的进程有这些变量，交互 shell 没有：从仓库外的 env 文件补 */
export function loadEnvFile(): void {
  const f = path.join(process.env.HOME ?? "", ".config", "rabbit-bot", "env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}

function apiKey(): string {
  loadEnvFile();
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("没有 DEEPSEEK_API_KEY，联网不可用");
  return key;
}

export interface SearchOptions {
  count?: number;
  content?: boolean;
}

export async function searchWeb(query: string, opts: SearchOptions = {}) {
  const key = apiKey();
  const q = String(query ?? "").trim().slice(0, 128);
  if (!q) throw new Error("缺少查询词");
  const count = Math.min(10, Math.max(1, Math.floor(opts.count ?? 6)));
  const res = await fetch("https://api.deepseek.com/v1/tools/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: q, count, need_content: !!opts.content }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results || []).filter((r) => r?.title && r?.url).map((r) => ({
    title: r.title,
    url: r.url,
    site: r.site_name ?? null,
    date: r.date ?? null,
    summary: String(r.content ?? r.summary ?? r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
  }));
}

export async function fetchWeb(url: string) {
  const key = apiKey();
  if (!url) throw new Error("缺少 url");
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支持 http/https");
  const res = await fetch("https://api.deepseek.com/v1/tools/fetch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ url: u.toString() }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`抓取失败 HTTP ${res.status}`);
  const data = (await res.json()) as { title?: string; content?: string };
  const body = String(data.content ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return { url: u.toString(), title: data.title ?? null, chars: body.length, truncated: body.length > 6000, content: body.slice(0, 6000) };
}
