#!/usr/bin/env node
/** 抓网页正文（Markdown）。npx tsx scripts/web-fetch.ts <url> */
import { run, describe } from "./lib/kit.ts";
import { fetchWeb } from "../src/ops/web.ts";

describe("npx tsx scripts/web-fetch.ts <url>");

await run(async ({ pos }) => {
  return fetchWeb(pos[0] ?? "");
});
