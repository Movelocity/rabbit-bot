/** 沙盒文件区与 shell：宿主 API 和沙盒 rb 客户端共用。 */
import path from "node:path";
import { APP_ROOT, type Config } from "../config.ts";
import { createSandboxFs } from "../core/sandbox-fs.ts";
import { runShell, type SandboxArgvOptions } from "../core/shell-runner.ts";
import { apiEnv, resolveApiToken } from "../api-token.ts";
import { ensureSkillDataDirs } from "./skills.ts";
import { runtimeOverlays, sharedSkillRoots } from "../core/runtime.ts";

function sbox(cfg: Config, root?: string) {
  const sc = cfg.exec;
  return createSandboxFs({
    root: root ? path.resolve(root) : sc.dir,
    maxFileBytes: sc.maxFileBytes,
    maxFiles: sc.maxFiles,
    maxReadChars: sc.maxReadChars,
    overlays: runtimeOverlays(cfg),
    trustedRoots: sharedSkillRoots(cfg),
  });
}

/**
 * 额外挂进 /work 的目录（沙盒根不是运行时目录时的 prompt/topics、以及外部技能库）。
 * Docker 允许在同一个父挂载下再挂子路径，后者覆盖前者。
 */
function withRuntimeVolumes(cfg: Config): SandboxArgvOptions["volumes"] {
  const vols = [...cfg.exec.shell.volumes];
  for (const [name, host] of Object.entries(runtimeOverlays(cfg))) {
    // 外部技能库只读：容器里 cat 得到，改不了别人的库
    vols.push({ host, container: `/work/${name}`, mode: name === "shared-skills" ? "ro" : "rw" });
  }
  return vols;
}

/** 沙盒 shell 的完整参数；会自动补上 RB_API_URL / RB_API_TOKEN。 */
export function shellRunnerOptions(cfg: Config, timeoutMs?: number): SandboxArgvOptions {
  const sc = cfg.exec.shell;
  return {
    mode: sc.mode,
    container: sc.container,
    image: sc.image,
    network: sc.network,
    volumes: withRuntimeVolumes(cfg),
    workdir: "/work",
    // hostCwd 只对 host 模式有意义；docker 模式由 terminal 的 cwd 参数传容器内路径
    hostCwd: (sc.mode ?? "docker") === "host" ? sc.host?.cwd : undefined,
    hostInheritEnv: sc.host?.inheritEnv,
    env: cfg.api?.enabled === false ? { ...sc.env } : { ...sc.env, ...apiEnv(cfg, resolveApiToken(cfg)) },
    hostPrefix: [process.execPath, path.join(APP_ROOT, "docker", "rb.mjs")],
    timeoutMs: timeoutMs ?? sc.timeoutMs,
    maxOutputChars: sc.maxOutputChars,
  };
}

export function listSandboxFiles(cfg: Config, subdir = "") {
  return sbox(cfg).list(subdir);
}

export function readSandboxFile(cfg: Config, p: string, root?: string) {
  if (!p) throw new Error("缺少路径");
  return { path: p, content: sbox(cfg, root).read(p) };
}

export function writeSandboxFile(cfg: Config, p: string, content: string, root?: string) {
  if (!p) throw new Error("缺少路径");
  if (typeof content !== "string") throw new Error("缺少 content");
  return { path: p, bytes: sbox(cfg, root).write(p, content) };
}

/** terminal 的最终超时秒数：UFA 受 ufaMaxTimeoutMs 硬上限约束，WA 最多 600。 */
export function shellTimeoutSec(profile: "ufa" | "wa" | "review", cfg: Config, requested?: number): number {
  const defaultSec = Math.max(1, Math.floor(cfg.exec.shell.timeoutMs / 1000));
  const maxSec = profile === "ufa" ? Math.max(1, Math.floor(cfg.exec.shell.ufaMaxTimeoutMs / 1000)) : 600;
  const base = Number.isFinite(requested) && (requested as number) > 0 ? (requested as number) : defaultSec;
  return Math.min(maxSec, Math.max(1, Math.floor(base)));
}

export async function execShell(
  cfg: Config,
  cmd: string,
  timeoutSec?: number,
  opts: { cwd?: string; overflowFile?: string } = {},
) {
  const sc = cfg.exec;
  if (!sc.shell.enabled) throw new Error("沙盒 shell 没开");
  if (!cmd) throw new Error("缺少命令");
  // 新加的技能目录可能还没 data/；跑命令前补一次，技能里直接写 data/ 不会 ENOENT
  ensureSkillDataDirs(cfg);
  // 上限从 30 秒放到 600 秒：构建/装包/转录这类活 30 秒根本跑不完，
  // 30 秒的硬上限等于逼模型「拆成十条命令」，反而更慢更容易错。
  const secs = Math.min(600, Math.max(1, Math.floor(timeoutSec ?? sc.shell.timeoutMs / 1000)));
  const o = shellRunnerOptions(cfg, secs * 1000);
  if (opts.cwd) o.hostCwd = opts.cwd;
  if (opts.overflowFile) o.overflowFile = opts.overflowFile;
  const r = await runShell(cmd, o);
  return { code: r.code, ok: r.ok, output: r.output };
}
