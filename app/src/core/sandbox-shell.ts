/**
 * 沙盒 shell：命令跑在一个 Docker 容器里，不是宿主机。
 *
 * 容器的边界（创建时固定，改这里等于改安全边界）：
 *   --network <network>     "none" 完全断网；"bridge" 有网（按需，见 config.sandbox.shell.network）
 *   --read-only             根文件系统只读，只有 /work 和 /tmp(tmpfs) 可写
 *   --cap-drop ALL          丢弃全部 capability
 *   no-new-privileges       不许提权
 *   --memory 512m --pids-limit 64 --cpus 1（/tmp 是 256m 的 tmpfs，pip 装包落这里）
 *   只把 data/sandbox 挂成 /work，宿主其余路径在容器里根本不存在
 *
 * 所以即使模型在容器里跑 `cat ~/.config/poolchat/env`，它看到的是 No such file。
 */
import { execFile } from "node:child_process";

export interface SandboxShellOptions {
  container: string;
  image: string;
  /** "bridge" 有网（装包、抓网页）；"none" 完全断网。 */
  network: "bridge" | "none";
  /** 宿主的沙盒目录，挂进容器当 /work。 */
  workspace: string;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface SandboxShellResult {
  ok: boolean;
  code: number;
  output: string;
}

const MAX_CMD_CHARS = 4000;

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20, encoding: "utf8" }, (e, stdout, stderr) => {
      const err = e as (Error & { code?: number | string; killed?: boolean }) | null;
      const code = !err ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, out: stdout ?? "", err: stderr ?? (err && !stderr ? err.message : "") });
    });
  });
}

/** 保证容器在跑：在跑就返回；停了就 start；不存在就按边界建一个。 */
export async function ensureSandboxContainer(opts: SandboxShellOptions): Promise<{ ok: boolean; message: string }> {
  const probe = await run("docker", ["inspect", "-f", "{{.State.Running}}", opts.container], 15000);
  if (probe.code === 0) {
    if (probe.out.trim() === "true") return { ok: true, message: "running" };
    const started = await run("docker", ["start", opts.container], 30000);
    if (started.code === 0) return { ok: true, message: "started" };
    return { ok: false, message: `容器启动失败：${started.err.trim().slice(0, 200)}` };
  }

  const created = await run(
    "docker",
    [
      "run", "-d",
      "--name", opts.container,
      "--network", opts.network,
      "--memory", "512m", "--memory-swap", "512m",
      "--cpus", "1",
      "--pids-limit", "64",
      "--read-only",
      "--tmpfs", "/tmp:rw,size=256m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--restart", "unless-stopped",
      "-v", `${opts.workspace}:/work:rw`,
      "-w", "/work",
      "--user", `${process.getuid?.() ?? 501}:${process.getgid?.() ?? 20}`,
      opts.image,
      "sleep", "infinity",
    ],
    180000,
  );
  if (created.code !== 0) return { ok: false, message: `建容器失败：${created.err.trim().slice(0, 300)}` };
  return { ok: true, message: "created" };
}

/** 在沙盒容器里跑一段 shell（sh -lc）。命令字符串不进宿主 shell，走 execFile 参数传递。 */
export async function runInSandbox(cmd: string, opts: SandboxShellOptions): Promise<SandboxShellResult> {
  const trimmed = (cmd ?? "").trim();
  if (!trimmed) throw new Error("cmd 不能为空");
  if (trimmed.length > MAX_CMD_CHARS) throw new Error(`cmd 太长（上限 ${MAX_CMD_CHARS} 字）`);

  const ready = await ensureSandboxContainer(opts);
  if (!ready.ok) throw new Error(ready.message);

  // 超时交给容器里的 timeout：只杀 docker CLI 的话，容器里的进程会继续跑成孤儿。
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const r = await run("docker", ["exec", opts.container, "timeout", "-s", "KILL", String(secs), "sh", "-lc", trimmed], opts.timeoutMs + 5000);
  const combined = `${r.out}${r.err}`;
  const clipped =
    combined.length > opts.maxOutputChars
      ? `${combined.slice(0, opts.maxOutputChars)}\n…（输出已截断，共 ${combined.length} 字）`
      : combined;
  const timedOut = r.code === 137 || r.code === 124;
  const body = clipped.trim();
  return { ok: r.code === 0, code: r.code, output: timedOut ? `${body}${body ? "\n" : ""}（超过 ${secs} 秒被终止）` : body };
}
