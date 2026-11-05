/**
 * 沙盒 shell：默认跑在 Docker 容器里，不是宿主机。
 *
 * mode="docker" 的边界（创建时固定，改这里等于改安全边界）：
 *   --network <network>     "none" 完全断网；"bridge" 有网（按需，见 config.sandbox.shell.network）
 *   --read-only             根文件系统只读，只有 /work 和 /tmp(tmpfs) 可写
 *   --cap-drop ALL          丢弃全部 capability
 *   no-new-privileges       不许提权
 *   --memory 512m --pids-limit 64 --cpus 1（/tmp 是 256m 的 tmpfs，pip 装包落这里）
 *   只把 data/sandbox 挂成 /work，宿主其余路径在容器里根本不存在
 *
 * 所以即使模型在容器里跑 `cat ~/.config/rabbit-bot/env`，它看到的是 No such file。
 *
 * mode="host" 是**无隔离**的本地开发模式：命令直接在本机 bash 里跑，cwd 是沙盒目录。
 * 模型能看到 ~/.config/rabbit-bot/env 和任意宿主路径。只在 config/local.json 里开。
 */
import { execFile } from "node:child_process";

export type SandboxMode = "docker" | "host";

export interface VolumeSpec {
  /** 宿主机路径（绝对路径） */
  host: string;
  /** 容器内路径 */
  container: string;
  mode?: "ro" | "rw";
}

export interface SandboxShellOptions {
  /** 默认 "docker"；"host" 无隔离，仅开发用。 */
  mode?: SandboxMode;
  container: string;
  image: string;
  /** "bridge" 有网（装包、抓网页）；"none" 完全断网。 */
  network: "bridge" | "none";
  /** 要挂进容器的宿主机目录。宿主其余路径在容器里不存在。 */
  volumes: VolumeSpec[];
  /** 容器内工作目录（默认 /work）。 */
  workdir?: string;
  timeoutMs: number;
  maxOutputChars: number;
  /** host 模式的 cwd；不填就用挂到 /work 的那条卷的宿主路径。 */
  hostCwd?: string;
  /** host 模式是否继承父进程环境变量（默认 false，只给 PATH/HOME/LANG/TERM/TMPDIR）。 */
  hostInheritEnv?: boolean;
  /** 额外注入容器的环境变量（API 地址/token 走这里）。host 模式下只在 hostInheritEnv 时生效。 */
  env?: Record<string, string>;
}

export interface SandboxShellResult {
  ok: boolean;
  code: number;
  output: string;
}

const MAX_CMD_CHARS = 4000;
const HOST_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];

interface RawResult {
  code: number;
  out: string;
  err: string;
  killed?: boolean;
  signal?: string;
}

function run(bin: string, args: string[], timeoutMs: number, cwd?: string, env?: NodeJS.ProcessEnv): Promise<RawResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 1 << 20, encoding: "utf8", cwd, env, killSignal: "SIGKILL" },
      (e, stdout, stderr) => {
        const err = e as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
        const code = !err ? 0 : typeof err.code === "number" ? err.code : 1;
        resolve({
          code,
          out: stdout ?? "",
          err: stderr ?? (err && !stderr ? err.message : ""),
          killed: err?.killed,
          signal: err?.signal,
        });
      },
    );
  });
}

function clip(combined: string, maxOutputChars: number): string {
  return combined.length > maxOutputChars
    ? `${combined.slice(0, maxOutputChars)}\n…（输出已截断，共 ${combined.length} 字）`
    : combined;
}

function timeoutMark(body: string, secs: number, timedOut: boolean): string {
  return timedOut ? `${body}${body ? "\n" : ""}（超过 ${secs} 秒被终止）` : body;
}

function checkCmd(cmd: string): string {
  const trimmed = (cmd ?? "").trim();
  if (!trimmed) throw new Error("cmd 不能为空");
  if (trimmed.length > MAX_CMD_CHARS) throw new Error(`cmd 太长（上限 ${MAX_CMD_CHARS} 字）`);
  return trimmed;
}

/** 容器里已有的环境变量是否和我们期望的一致（token 轮换后要重建容器）。 */
async function envMatches(container: string, env: Record<string, string>): Promise<boolean> {
  if (!Object.keys(env).length) return true;
  const r = await run("docker", ["inspect", "-f", "{{json .Config.Env}}", container], 15000);
  if (r.code !== 0) return false;
  let cur: string[] = [];
  try { cur = JSON.parse(r.out.trim() || "[]") as string[]; } catch { return false; }
  const map = new Map(cur.map((s) => {
    const i = s.indexOf("=");
    return [s.slice(0, i), s.slice(i + 1)] as const;
  }));
  return Object.entries(env).every(([k, v]) => map.get(k) === v);
}

/**
 * 挂载点变了也要重建：容器是长活的，挂载只在 `docker run` 那一刻生效。
 * 运行时目录（人设/话题库）第一次接进来时不重建，容器里看到的还是旧的空壳。
 */
async function mountsMatch(container: string, volumes: SandboxShellOptions["volumes"]): Promise<boolean> {
  const r = await run("docker", ["inspect", "-f", "{{range .Mounts}}{{.Source}}=>{{.Destination}};{{end}}", container], 15000);
  if (r.code !== 0) return false;
  const cur = new Set(r.out.trim().split(";").filter(Boolean));
  const want = new Set(volumes.map((v) => `${v.host}=>${v.container}`));
  if (cur.size !== want.size) return false;
  for (const w of want) if (!cur.has(w)) return false;
  return true;
}

/** 保证容器在跑：在跑就返回；停了就 start；不存在就按边界建一个。env 或挂载变了会重建。 */
export async function ensureSandboxContainer(opts: SandboxShellOptions): Promise<{ ok: boolean; message: string }> {
  const desired = opts.env ?? {};
  const probe = await run("docker", ["inspect", "-f", "{{.State.Running}}", opts.container], 15000);
  if (probe.code === 0) {
    if (!(await envMatches(opts.container, desired)) || !(await mountsMatch(opts.container, opts.volumes))) {
      await run("docker", ["rm", "-f", opts.container], 30000);
    } else if (probe.out.trim() === "true") return { ok: true, message: "running" };
    else {
      const started = await run("docker", ["start", opts.container], 30000);
      if (started.code === 0) return { ok: true, message: "started" };
      return { ok: false, message: `容器启动失败：${started.err.trim().slice(0, 200)}` };
    }
  }

  const created = await run(
    "docker",
    [
      "run", "-d",
      "--name", opts.container,
      "--network", opts.network,
      "--add-host", "host.docker.internal:host-gateway",
      "--memory", "512m", "--memory-swap", "512m",
      "--cpus", "1",
      "--pids-limit", "64",
      "--read-only",
      "--tmpfs", "/tmp:rw,size=256m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--restart", "unless-stopped",
      ...Object.entries(desired).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      ...opts.volumes.flatMap((v) => ["-v", `${v.host}:${v.container}:${v.mode ?? "rw"}`]),
      "-w", opts.workdir ?? "/work",
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
export async function runInDocker(cmd: string, opts: SandboxShellOptions): Promise<SandboxShellResult> {
  const trimmed = checkCmd(cmd);

  const ready = await ensureSandboxContainer(opts);
  if (!ready.ok) throw new Error(ready.message);

  // 超时交给容器里的 timeout：只杀 docker CLI 的话，容器里的进程会继续跑成孤儿。
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const r = await run("docker", ["exec", opts.container, "timeout", "-s", "KILL", String(secs), "sh", "-lc", trimmed], opts.timeoutMs + 5000);
  const timedOut = r.code === 137 || r.code === 124;
  return {
    ok: r.code === 0,
    code: r.code,
    output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars).trim(), secs, timedOut),
  };
}

/** host 模式的 cwd：优先显式配置，否则用挂到 /work 的那条卷。 */
function hostCwd(opts: SandboxShellOptions): string | undefined {
  return opts.hostCwd ?? opts.volumes.find((v) => v.container === "/work")?.host ?? opts.workdir;
}

/** host 模式的环境变量：默认白名单，inheritEnv 才继承；再叠 opts.env。 */
function hostEnv(opts: SandboxShellOptions, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...(opts.hostInheritEnv
      ? process.env
      : Object.fromEntries(HOST_ENV_KEYS.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]])))),
    ...opts.env,
    ...extra,
  };
}

/**
 * 在宿主机上跑一段 shell（bash -c）。**没有隔离**：能读宿主文件、偷环境变量之外的密钥文件。
 * 用 -c 而不是 -lc：登录 shell 会读 ~/.bash_profile，可能把我们刚过滤掉的环境变量又塞回来。
 * 只在配置 mode="host" 时走到这里，给本地开发省掉 docker 那一层。
 */
export async function runOnHost(cmd: string, opts: SandboxShellOptions): Promise<SandboxShellResult> {
  const trimmed = checkCmd(cmd);
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const r = await run("bash", ["-c", trimmed], opts.timeoutMs, hostCwd(opts), hostEnv(opts));
  const timedOut = r.killed === true || r.signal === "SIGKILL";
  return {
    ok: r.code === 0 && !timedOut,
    code: r.code,
    output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars).trim(), secs, timedOut),
  };
}

export interface SandboxArgvOptions extends SandboxShellOptions {
  /** host 模式下 argv[0] 的替代启动器，例如 [node, /path/rb.mjs]；argv 其余部分原样传给它 */
  hostPrefix?: string[];
  /** 只对本次执行注入的环境变量（docker exec -e / host env） */
  execEnv?: Record<string, string>;
}

/**
 * 按 argv 直接执行（不过 shell）：模型拼不出 `; rm -rf`。
 * 用于沙盒里的 rb 客户端——docker 模式执行镜像里的 `rb`，host 模式执行仓库里的 docker/rb.mjs。
 */
export async function runSandboxArgv(argv: string[], opts: SandboxArgvOptions): Promise<SandboxShellResult> {
  if (!argv.length) throw new Error("argv 不能为空");
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));

  if ((opts.mode ?? "docker") === "host") {
    const [bin, ...prefix] = opts.hostPrefix ?? [];
    if (!bin) throw new Error("host 模式需要 hostPrefix（rb 客户端入口）");
    // hostPrefix 顶替 argv[0]（容器里是 /usr/local/bin/rb，宿主上是 node docker/rb.mjs）
    const r = await run(bin, [...prefix, ...argv.slice(1)], opts.timeoutMs, hostCwd(opts), hostEnv(opts, opts.execEnv));
    const timedOut = r.killed === true || r.signal === "SIGKILL";
    return {
      ok: r.code === 0 && !timedOut,
      code: r.code,
      output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars).trim(), secs, timedOut),
    };
  }

  const ready = await ensureSandboxContainer(opts);
  if (!ready.ok) throw new Error(ready.message);

  const envArgs = Object.entries(opts.execEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await run(
    "docker",
    ["exec", ...envArgs, opts.container, "timeout", "-s", "KILL", String(secs), ...argv],
    opts.timeoutMs + 5000,
  );
  const timedOut = r.code === 137 || r.code === 124;
  return {
    ok: r.code === 0,
    code: r.code,
    output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars).trim(), secs, timedOut),
  };
}

/** 按 mode 分发：docker（默认，隔离）或 host（无隔离，开发用）。 */
export async function runShell(cmd: string, opts: SandboxShellOptions): Promise<SandboxShellResult> {
  return (opts.mode ?? "docker") === "host" ? runOnHost(cmd, opts) : runInDocker(cmd, opts);
}
