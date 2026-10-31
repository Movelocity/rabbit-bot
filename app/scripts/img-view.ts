#!/usr/bin/env node
/** 给出一张图的真实路径和尺寸。看图本身仍由 agent 的 view_image 工具做（CLI 塞不进上下文）。
 *  npx tsx scripts/img-view.ts media/om_xxx.jpg */
import fs from "node:fs";
import { run, describe } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";
import { resolveImagePath } from "../src/ops/images.ts";

describe("npx tsx scripts/img-view.ts <media/… 或 inbox/…>");

await run(({ pos }) => {
  const cfg = loadConfig({});
  const abs = resolveImagePath(cfg.dataDir, pos[0] ?? "");
  return { path: abs, bytes: fs.statSync(abs).size, exists: true };
});
