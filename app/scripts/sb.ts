#!/usr/bin/env node
/**
 * 沙盒文件区（根目录固定，只收相对路径）。
 *   npx tsx scripts/sb.ts list [子目录]
 *   npx tsx scripts/sb.ts read notes/todo.md
 *   npx tsx scripts/sb.ts write notes/x.md --content "…"   或 --from-file 本地文件
 *   npx tsx scripts/sb.ts run "ls -la /work" [--timeout 10]
 */
import fs from "node:fs";
import { run, describe, str, num } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";
import { createSandboxFs } from "../src/core/sandbox-fs.ts";
import { runInSandbox } from "../src/core/sandbox-shell.ts";

describe("npx tsx scripts/sb.ts list|read|write|run …（沙盒根固定，路径一律相对）");

await run(async ({ pos, flags }) => {
  const cfg = loadConfig({});
  const sc = cfg.sandbox;
  const sbox = () => createSandboxFs({ root: sc.dir, maxFileBytes: sc.maxFileBytes, maxFiles: sc.maxFiles, maxReadChars: sc.maxReadChars });
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
  throw new Error("子命令：list | read | write | run");
});
