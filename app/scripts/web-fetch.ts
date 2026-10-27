#!/usr/bin/env node
/** 抓网页正文（Markdown）。npx tsx scripts/web-fetch.ts <url> */
import { run, describe, loadEnvFile } from "./lib/kit.ts";

describe("npx tsx scripts/web-fetch.ts <url>");

await run(async ({ pos }) => {
  loadEnvFile();
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("没有 DEEPSEEK_API_KEY，联网不可用");
  const raw = pos[0];
  if (!raw) throw new Error("缺少 url");
  const u = new URL(raw);
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
});
