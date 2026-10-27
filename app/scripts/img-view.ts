#!/usr/bin/env node
/** 给出一张图的真实路径和尺寸。看图本身仍由 agent 的 view_image 工具做（CLI 塞不进上下文）。
 *  npx tsx scripts/img-view.ts media/om_xxx.jpg */
import path from "node:path";
import fs from "node:fs";
import { run, describe } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";

describe("npx tsx scripts/img-view.ts <media/… 或 inbox/…>");

await run(({ pos }) => {
  const target = pos[0];
  if (!target) throw new Error("缺少图片路径");
  const cfg = loadConfig({});
  const roots = [path.join(cfg.dataDir, "inbox"), path.join(cfg.dataDir, "media")];
  const bare = target.replace(/^(media|inbox)[/\\]/, "");
  for (const root of roots) {
    for (const rel of [target, bare]) {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) continue;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { path: abs, bytes: fs.statSync(abs).size, exists: true };
      }
    }
  }
  throw new Error(`没有这张图：${target}（先跑 img-list 看有哪些）`);
});
