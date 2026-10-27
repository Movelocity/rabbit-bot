#!/usr/bin/env node
/** 联网搜索（DeepSeek 官方搜索接口）。npx tsx scripts/web-search.ts "查询词" [--count 6] [--content] */
import { run, describe, str, num, bool, loadEnvFile } from "./lib/kit.ts";

describe('npx tsx scripts/web-search.ts <查询> [--count 6] [--content]');

await run(async ({ pos, flags }) => {
  loadEnvFile();
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("没有 DEEPSEEK_API_KEY，联网不可用");
  const query = (pos[0] ?? str(flags, "query") ?? "").trim().slice(0, 128);
  if (!query) throw new Error("缺少查询词");
  const count = Math.min(10, Math.max(1, num(flags, "count") ?? 6));
  const res = await fetch("https://api.deepseek.com/v1/tools/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, count, need_content: bool(flags, "content") }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`搜索失败 HTTP ${res.status}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results || []).filter((r) => r?.title && r?.url).map((r) => ({
    title: r.title, url: r.url, site: r.site_name ?? null, date: r.date ?? null,
    summary: String(r.content ?? r.summary ?? r.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
  }));
});
