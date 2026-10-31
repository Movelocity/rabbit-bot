/** 沙盒文件区与 shell。CLI（scripts/sb.ts）和 API 都走这里。 */
import type { Config } from "../config.ts";
import { createSandboxFs } from "../core/sandbox-fs.ts";
import { runShell, type SandboxShellOptions } from "../core/sandbox-shell.ts";
import { apiEnv, resolveApiToken } from "../api-token.ts";
import { ensureSkillDataDirs } from "./skills.ts";

function sbox(cfg: Config) {
  const sc = cfg.sandbox;
  return createSandboxFs({
    root: sc.dir,
    maxFileBytes: sc.maxFileBytes,
    maxFiles: sc.maxFiles,
    maxReadChars: sc.maxReadChars,
  });
}

/** 沙盒 shell 的完整参数；会自动补上 RB_API_URL / RB_API_TOKEN。 */
export function sandboxShellOptions(cfg: Config, timeoutMs?: number): SandboxShellOptions {
  const sc = cfg.sandbox.shell;
  return {
    mode: sc.mode,
    container: sc.container,
    image: sc.image,
    network: sc.network,
    volumes: sc.volumes,
    workdir: "/work",
    hostCwd: sc.host?.cwd,
    hostInheritEnv: sc.host?.inheritEnv,
    env: cfg.api?.enabled === false ? { ...sc.env } : { ...sc.env, ...apiEnv(cfg, resolveApiToken(cfg)) },
    timeoutMs: timeoutMs ?? sc.timeoutMs,
    maxOutputChars: sc.maxOutputChars,
  };
}

export function listSandboxFiles(cfg: Config, subdir = "") {
  return sbox(cfg).list(subdir);
}

export function readSandboxFile(cfg: Config, p: string) {
  if (!p) throw new Error("缺少路径");
  return { path: p, content: sbox(cfg).read(p) };
}

export function writeSandboxFile(cfg: Config, p: string, content: string) {
  if (!p) throw new Error("缺少路径");
  if (typeof content !== "string") throw new Error("缺少 content");
  return { path: p, bytes: sbox(cfg).write(p, content) };
}

export async function runSandboxShell(cfg: Config, cmd: string, timeoutSec?: number) {
  const sc = cfg.sandbox;
  if (!sc.shell.enabled) throw new Error("沙盒 shell 没开");
  if (!cmd) throw new Error("缺少命令");
  // 新加的技能目录可能还没 data/；跑命令前补一次，技能里直接写 data/ 不会 ENOENT
  ensureSkillDataDirs(cfg);
  const secs = Math.min(30, Math.max(1, Math.floor(timeoutSec ?? sc.shell.timeoutMs / 1000)));
  const r = await runShell(cmd, sandboxShellOptions(cfg, secs * 1000));
  return { code: r.code, ok: r.ok, output: r.output };
}
