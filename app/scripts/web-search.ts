#!/usr/bin/env node
/** 联网搜索（DeepSeek 官方搜索接口）。npx tsx scripts/web-search.ts "查询词" [--count 6] [--content] */
import { run, describe, str, num, bool } from "./lib/kit.ts";
import { searchWeb } from "../src/ops/web.ts";

describe('npx tsx scripts/web-search.ts <查询> [--count 6] [--content]');

await run(async ({ pos, flags }) => {
  return searchWeb(pos[0] ?? str(flags, "query") ?? "", {
    count: num(flags, "count"),
    content: bool(flags, "content"),
  });
});
