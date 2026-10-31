#!/usr/bin/env node
/**
 * 沙盒文件区（根目录固定，只收相对路径）。
 *   npx tsx scripts/sb.ts list [子目录]
 *   npx tsx scripts/sb.ts read notes/todo.md
 *   npx tsx scripts/sb.ts write notes/x.md --content "…"
 *   npx tsx scripts/sb.ts run "ls -la /work" [--timeout 10]
 *
 * run 的模式由 config.sandbox.shell.mode 决定：
 *   docker（默认）→ 命令在容器里跑，工作目录 /work，自动带 RB_API_URL / RB_API_TOKEN
 *   host（仅本地开发）→ 命令直接在本机 bash 里跑，工作目录是 data/sandbox，路径写宿主绝对路径
 */
import { run, describe, str, num } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";
import { listSandboxFiles, readSandboxFile, writeSandboxFile, runSandboxShell } from "../src/ops/sandbox.ts";

describe("npx tsx scripts/sb.ts list|read|write|run …（沙盒根固定，路径一律相对）");

await run(async ({ pos, flags }) => {
  const cfg = loadConfig({});
  const sub = pos[0];
  if (sub === "list") return listSandboxFiles(cfg, pos[1] ?? "");
  if (sub === "read") return readSandboxFile(cfg, pos[1] ?? "");
  if (sub === "write") {
    const content = str(flags, "content");
    if (content === undefined) throw new Error("缺少 --content");
    return writeSandboxFile(cfg, pos[1] ?? "", content);
  }
  if (sub === "run") {
    const cmd = pos.slice(1).join(" ") || str(flags, "cmd");
    return runSandboxShell(cfg, cmd ?? "", num(flags, "timeout"));
  }
  throw new Error("子命令：list | read | write | run");
});
