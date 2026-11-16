/** 宿主平台差异：路径包含判断、home/env 位置、可执行文件解析、进程树信号。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface PathImpl {
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(p: string): boolean;
  readonly sep: string;
}

export function expandHome(p: string, home = os.homedir()): string {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("~") ? path.join(home, raw.slice(1)) : raw;
}

export function envFile(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const explicit = String(env.RABBIT_BOT_ENV_FILE ?? "").trim();
  if (explicit) return path.resolve(expandHome(explicit, home));
  return path.join(home, ".config", "rabbit-bot", "env");
}

export function isInsideWith(root: string, abs: string, impl: PathImpl, caseInsensitive = false): boolean {
  if (!root || !abs) return false;
  let r = impl.resolve(root);
  let a = impl.resolve(abs);
  if (caseInsensitive) {
    r = r.toLowerCase();
    a = a.toLowerCase();
  }
  if (r === a) return true;
  const rel = impl.relative(r, a);
  return !!rel && rel !== ".." && !rel.startsWith(`..${impl.sep}`) && !impl.isAbsolute(rel);
}

export function isInside(root: string, abs: string): boolean {
  return isInsideWith(root, abs, path, process.platform === "win32");
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 把命令名解析成可执行文件路径；找不到时原样返回，交给调用方报错。 */
export function resolveExecutable(bin: string): string {
  const raw = String(bin ?? "").trim();
  if (!raw) return raw;
  if (path.isAbsolute(raw)) {
    if (process.platform !== "win32" || fs.existsSync(raw)) return raw;
    for (const ext of [".cmd", ".exe", ".bat"]) {
      if (fs.existsSync(raw + ext)) return raw + ext;
    }
    return raw;
  }
  if (process.platform === "win32") {
    const out = spawnSync("where", [raw], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (out.status === 0) {
      const first = String(out.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    }
    return raw;
  }
  const out = spawnSync("sh", ["-c", `command -v ${shellQuote(raw)}`], { encoding: "utf8", timeout: 5000 });
  return out.status === 0 ? (String(out.stdout ?? "").trim() || raw) : raw;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  shell: boolean;
}

/** Windows 的 npm 安装形态是 .cmd 垫片，Node 直接 spawn 会 ENOENT，需要交给 cmd 解释。 */
export function spawnPlan(bin: string, args: string[] = [], platform = process.platform): SpawnPlan {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    return { file: bin, args, shell: true };
  }
  return { file: bin, args, shell: false };
}

export function hostModeSupported(platform = process.platform): boolean {
  return platform !== "win32";
}

export function assertHostModeSupported(): void {
  if (!hostModeSupported()) {
    throw new Error("Windows 原生不支持 host 模式：请使用 docker 模式，或把 rabbit-bot 部署到 WSL2 后运行");
  }
}

export interface KillPlan {
  bin: string;
  args: string[];
}

/** POSIX 杀进程组（负 pid）；Windows 返回 taskkill 命令。 */
export function killPlan(pid: number, signal: NodeJS.Signals, platform = process.platform): KillPlan | null {
  if (platform !== "win32") return null;
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") args.push("/F");
  return { bin: "taskkill", args };
}

export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  const plan = killPlan(pid, signal);
  if (plan) {
    const out = spawnSync(plan.bin, plan.args, { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (out.status === 0) return;
    try { process.kill(pid, signal); } catch { /* 已经没了 */ }
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch { /* 不是组长或已经没了 */ }
  try { process.kill(pid, signal); } catch { /* 已经没了 */ }
}

export function procStartTimeCommand(pid: number, platform = process.platform): KillPlan {
  if (platform === "win32") {
    return {
      bin: "powershell.exe",
      args: [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
      ],
    };
  }
  return { bin: "/bin/ps", args: ["-p", String(pid), "-o", "lstart="] };
}
