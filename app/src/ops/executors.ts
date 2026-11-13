/** 本机可调用的 CLI 执行器：探测可执行文件和版本，给管理台展示用。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface ExecutorInfo {
  name: "opencode" | "mimo";
  /** 实际要启动的可执行文件或命令 */
  bin: string;
  available: boolean;
  version: string;
  error: string;
}

function mimoBin(): string {
  return process.env.MIMO_BIN || path.join(os.homedir(), ".mimocode/bin/mimo");
}

function which(cmd: string): string {
  const out = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8", timeout: 5000 });
  return out.status === 0 ? out.stdout.trim() : "";
}

function probe(name: ExecutorInfo["name"], bin: string): ExecutorInfo {
  const resolved = bin === "opencode" ? which(bin) || bin : bin;
  if (path.isAbsolute(resolved) && !fs.existsSync(resolved)) {
    return { name, bin: resolved, available: false, version: "", error: "未安装" };
  }
  const out = spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (out.error) {
    return { name, bin: resolved, available: false, version: "", error: out.error.message };
  }
  if (out.status !== 0) {
    const err = String(out.stderr || out.stdout || "").trim().split("\n")[0];
    return { name, bin: resolved, available: false, version: "", error: err || `退出码 ${out.status}` };
  }
  const version = String(out.stdout || out.stderr || "").trim().split("\n")[0];
  return { name, bin: resolved, available: true, version, error: "" };
}

let cache: { at: number; list: ExecutorInfo[] } | null = null;
const TTL_MS = 30_000;

/** 探测顺序固定，前端不用自己排序；结果缓存 30 秒，避免每次开页面都 spawn。 */
export function listExecutors(now = Date.now()): ExecutorInfo[] {
  if (cache && now - cache.at < TTL_MS) return cache.list;
  const list = [probe("opencode", "opencode"), probe("mimo", mimoBin())];
  cache = { at: now, list };
  return list;
}
