/** 本机可调用的 CLI 执行器：探测可执行文件和版本，给管理台展示用。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Executor } from "../core/executor.ts";
import { resolveExecutable, spawnPlan } from "../core/platform.ts";

export interface ExecutorInfo {
  name: Executor;
  /** 实际要启动的可执行文件或命令 */
  bin: string;
  available: boolean;
  version: string;
  error: string;
}

function mimoBin(): string {
  return process.env.MIMO_BIN || path.join(os.homedir(), ".mimocode/bin/mimo");
}

function codexBin(): string {
  return process.env.CODEX_BIN || "codex";
}

function claudeBin(): string {
  return process.env.CLAUDE_BIN || "claude";
}

/** 异步探测，四个 CLI 并行跑；绝不阻塞事件循环（之前同步 spawn 一次要 1s+）。 */
function probe(name: ExecutorInfo["name"], bin: string): Promise<ExecutorInfo> {
  const resolved = resolveExecutable(bin);
  if (path.isAbsolute(resolved) && !fs.existsSync(resolved)) {
    return Promise.resolve({ name, bin: resolved, available: false, version: "", error: "未安装" });
  }
  const plan = spawnPlan(resolved, ["--version"]);
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const done = (info: ExecutorInfo) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(info);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.file, plan.args, { shell: plan.shell, windowsHide: true });
    } catch (e) {
      return resolve({ name, bin: resolved, available: false, version: "", error: (e as Error).message });
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ name, bin: resolved, available: false, version: "", error: "探测超时" });
    }, 10_000);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (e) => {
      done({ name, bin: resolved, available: false, version: "", error: e.message });
    });
    child.on("close", (code) => {
      const text = String(stdout || stderr || "").trim().split("\n")[0];
      if (code !== 0) {
        done({ name, bin: resolved, available: false, version: "", error: text || `退出码 ${code}` });
        return;
      }
      done({ name, bin: resolved, available: true, version: text, error: "" });
    });
  });
}

interface Cache {
  at: number;
  list: ExecutorInfo[];
}

let cache: Cache | null = null;
let inflight: Promise<ExecutorInfo[]> | null = null;
/** 版本号不会变，缓存久一点；过期后先回旧的、后台再刷新，请求永远不等 spawn。 */
const TTL_MS = 10 * 60_000;
/** 探测结果落盘，重启进程后第一个页面也不用等 600ms 的 --version。 */
let cacheFile = "";

/** 指定落盘位置并在启动时读回上次结果；传空字符串关闭。 */
export function configureExecutorCache(file: string): void {
  cacheFile = file;
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Cache;
    if (raw && Array.isArray(raw.list) && Number.isFinite(raw.at)) cache = { at: raw.at, list: raw.list };
  } catch {
    // 首次启动 / 文件损坏：忽略，等探测
  }
}

function persistCache(): void {
  if (!cacheFile || !cache) return;
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {
    // 缓存写不进去不影响探测结果
  }
}

/** 重新探测（并发请求共用一次）。 */
export function refreshExecutors(): Promise<ExecutorInfo[]> {
  if (inflight) return inflight;
  const pending = Promise.all([
    probe("opencode", "opencode"),
    probe("mimo", mimoBin()),
    probe("codex", codexBin()),
    probe("claude", claudeBin()),
  ])
    .then((list) => {
      cache = { at: Date.now(), list };
      persistCache();
      return list;
    })
    .finally(() => {
      if (inflight === pending) inflight = null;
    });
  inflight = pending;
  return pending;
}

/** 同步读缓存；没有缓存时返回空并后台探测，适合不关心等待的调用。 */
export function listExecutors(now = Date.now()): ExecutorInfo[] {
  if (cache) {
    if (now - cache.at >= TTL_MS) void refreshExecutors();
    return cache.list;
  }
  void refreshExecutors();
  return [];
}

/** 管理台用：有缓存立即返回（过期则后台刷新），首次调用等一轮并行探测。 */
export async function listExecutorsAsync(now = Date.now()): Promise<ExecutorInfo[]> {
  if (cache) {
    if (now - cache.at >= TTL_MS) void refreshExecutors();
    return cache.list;
  }
  return refreshExecutors();
}

/** 测试 / 换安装位置后清缓存，下次探测重新走环境变量。 */
export function resetExecutorProbeCache(): void {
  cache = null;
  inflight = null;
}