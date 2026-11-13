/**
 * 沙盒 shell：默认跑在 Docker 容器里，不是宿主机。
 *
 * mode="docker" 的边界（创建时固定，改这里等于改安全边界）：
 *   --network <network>     "none" 完全断网；"bridge" 有网（按需，见 config.exec.shell.network）
 *   --read-only             根文件系统只读，只有 /work 和 /tmp(tmpfs) 可写
 *   --cap-drop ALL          丢弃全部 capability
 *   no-new-privileges       不许提权
 *   --memory 1g --pids-limit 64 --cpus 1（/tmp 是 2g 的 tmpfs，pip 装包落这里）
 *   只把运行时目录（默认 ~/.config/rabbit-bot/runtime）挂成 /work，宿主其余路径在容器里根本不存在
 *
 * 所以即使模型在容器里跑 `cat ~/.config/rabbit-bot/env`，它看到的是 No such file。
 *
 * mode="host" 是**无隔离**的本地开发模式：命令直接在本机 bash 里跑，cwd 是沙盒目录。
 * 模型能看到 ~/.config/rabbit-bot/env 和任意宿主路径。只在 config/local.json 里开。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type SandboxMode = "docker" | "host";

export interface VolumeSpec {
  /** 宿主机路径（绝对路径） */
  host: string;
  /** 容器内路径 */
  container: string;
  mode?: "ro" | "rw";
}

export interface ShellRunnerOptions {
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
  /** 输出被截断时把全文写到这个文件（不给就直接丢）。让模型能「翻全文」而不是只看到头。 */
  overflowFile?: string;
}

export interface ShellRunnerResult {
  ok: boolean;
  code: number;
  output: string;
}

const MAX_CMD_CHARS = 4000;
const HOST_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];

// 容器边界值只在创建时生效；打个标签，改常量后下次 ensure 会自动重建（否则旧容器一直用老限制）。
const SANDBOX_MEMORY = "1g";
const SANDBOX_MEMORY_SWAP = "1g";
const SANDBOX_CPUS = "1";
const SANDBOX_PIDS = "64";
const SANDBOX_TMP_SIZE = "2g";
const SANDBOX_RESOURCES_LABEL = "rabbit-bot.sandbox-resources";
const SANDBOX_RESOURCES = `mem=${SANDBOX_MEMORY};swap=${SANDBOX_MEMORY_SWAP};cpus=${SANDBOX_CPUS};pids=${SANDBOX_PIDS};tmp=${SANDBOX_TMP_SIZE}`;

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

/**
 * 宿主模式专用：命令放进独立进程组，超时杀整组。
 *
 * execFile 的 timeout 只杀直接子进程（bash），它拉起的 npm/pytest 会继续跑成孤儿；
 * 5 秒上限就会变成「返回了但后台还在写」。这里用 detached + kill(-pid) 把整组带走。
 */
function runGroup(bin: string, args: string[], timeoutMs: number, cwd?: string, env?: NodeJS.ProcessEnv): Promise<RawResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 1, out: "", err: (e as Error).message });
      return;
    }
    const limit = 1 << 20;
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const append = (cur: string, chunk: Buffer | string): string =>
      cur.length >= limit ? cur : (cur + String(chunk)).slice(0, limit);
    const finish = (code: number, signal?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, out, err, killed: timedOut || signal === "SIGKILL", signal });
    };
    child.stdout?.on("data", (c) => { out = append(out, c); });
    child.stderr?.on("data", (c) => { err = append(err, c); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: 1, out, err: err || (e as Error).message });
    });
    child.on("close", (code, signal) => finish(code ?? 1, signal ?? undefined));
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* 已经退出 */ }
      }
    }, timeoutMs);
  });
}

function clip(combined: string, maxOutputChars: number, overflowFile?: string): string {
  if (combined.length <= maxOutputChars) return combined;
  let saved = "";
  if (overflowFile) {
    try {
      fs.mkdirSync(path.dirname(overflowFile), { recursive: true });
      fs.writeFileSync(overflowFile, combined, "utf8");
      saved = `，全文在 ${overflowFile}`;
    } catch { /* 写不进去就只报字数 */ }
  }
  return `${combined.slice(0, maxOutputChars)}\n…（输出已截断，共 ${combined.length} 字${saved}）`;
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
async function mountsMatch(container: string, volumes: ShellRunnerOptions["volumes"]): Promise<boolean> {
  // 连读写模式一起比：shared-skills 从 rw 改成 ro 也要重建容器
  const r = await run("docker", ["inspect", "-f", "{{range .Mounts}}{{.Source}}=>{{.Destination}}={{.RW}};{{end}}", container], 15000);
  if (r.code !== 0) return false;
  const cur = new Set(r.out.trim().split(";").filter(Boolean));
  const want = new Set(volumes.map((v) => `${v.host}=>${v.container}=${(v.mode ?? "rw") === "rw"}`));
  if (cur.size !== want.size) return false;
  for (const w of want) if (!cur.has(w)) return false;
  return true;
}

/** 资源边界（内存/pids/tmp）变了也要重建：这些只在 docker run 时生效，改常量不会影响已有容器。 */
async function resourcesMatch(container: string): Promise<boolean> {
  const r = await run("docker", ["inspect", "-f", `{{index .Config.Labels "${SANDBOX_RESOURCES_LABEL}"}}`, container], 15000);
  return r.code === 0 && r.out.trim() === SANDBOX_RESOURCES;
}

/** 保证容器在跑：在跑就返回；停了就 start；不存在就按边界建一个。env、挂载或资源边界变了会重建。 */
export async function ensureSandboxContainer(opts: ShellRunnerOptions): Promise<{ ok: boolean; message: string }> {
  const desired = opts.env ?? {};
  const probe = await run("docker", ["inspect", "-f", "{{.State.Running}}", opts.container], 15000);
  if (probe.code === 0) {
    if (
      !(await envMatches(opts.container, desired)) ||
      !(await mountsMatch(opts.container, opts.volumes)) ||
      !(await resourcesMatch(opts.container))
    ) {
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
      "--label", `${SANDBOX_RESOURCES_LABEL}=${SANDBOX_RESOURCES}`,
      "--network", opts.network,
      "--add-host", "host.docker.internal:host-gateway",
      "--memory", SANDBOX_MEMORY, "--memory-swap", SANDBOX_MEMORY_SWAP,
      "--cpus", SANDBOX_CPUS,
      "--pids-limit", SANDBOX_PIDS,
      "--read-only",
      "--tmpfs", `/tmp:rw,size=${SANDBOX_TMP_SIZE}`,
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

/**
 * 容器 State 还是 running、exec 却起不来：pids 计数泄漏（cgroup fork 被拒）或 runc 等不到 procReady。
 * 这种情况 restart 不一定能清掉泄漏的计数，直接删了重建。
 */
const BROKEN_EXEC_RE = /procReady not received|fork rejected by pids controller/i;

function execBroken(r: RawResult): boolean {
  return BROKEN_EXEC_RE.test(`${r.out}${r.err}`);
}

async function rebuildContainer(opts: ShellRunnerOptions): Promise<boolean> {
  await run("docker", ["rm", "-f", opts.container], 30000);
  return (await ensureSandboxContainer(opts)).ok;
}

/** 在沙盒容器里跑一段 shell（bash -lc）；cwd 是容器内路径。命令字符串不进宿主 shell，走 execFile 参数传递。 */
export async function runInDocker(cmd: string, opts: ShellRunnerOptions): Promise<ShellRunnerResult> {
  const trimmed = checkCmd(cmd);

  const ready = await ensureSandboxContainer(opts);
  if (!ready.ok) throw new Error(ready.message);

  // 超时交给容器里的 timeout：只杀 docker CLI 的话，容器里的进程会继续跑成孤儿。
  // cwd 用 docker exec -w 传容器内路径（不是宿主路径）。镜像有 bash 就用 bash，老镜像退回 sh。
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const exec = (shell: "bash" | "sh") => run("docker", [
    "exec",
    ...(opts.hostCwd ? ["-w", opts.hostCwd] : []),
    opts.container,
    "timeout", "-s", "KILL", String(secs),
    shell, "-lc", trimmed,
  ], opts.timeoutMs + 5000);
  const execWithShellFallback = async (): Promise<RawResult> => {
    const r = await exec("bash");
    return r.code === 127 && /bash/i.test(r.err) ? exec("sh") : r;
  };
  let r = await execWithShellFallback();
  if (execBroken(r) && (await rebuildContainer(opts))) r = await execWithShellFallback();
  const timedOut = r.code === 137 || r.code === 124;
  return {
    ok: r.code === 0,
    code: r.code,
    output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars, opts.overflowFile).trim(), secs, timedOut),
  };
}

/** host 模式的 cwd：优先显式配置，否则用挂到 /work 的那条卷。 */
function hostCwd(opts: ShellRunnerOptions): string | undefined {
  return opts.hostCwd ?? opts.volumes.find((v) => v.container === "/work")?.host ?? opts.workdir;
}

/** host 模式的环境变量：默认白名单，inheritEnv 才继承；再叠 opts.env。 */
function hostEnv(opts: ShellRunnerOptions, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...(opts.hostInheritEnv
      ? process.env
      : Object.fromEntries(HOST_ENV_KEYS.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]])))),
    ...opts.env,
    // 她自己的 Matrix 身份交给 shell：外部工具（callbot 之类）要「以我的号」做事，
    // 不该靠 --as 名字表——那是每接一个 agent 就得改一遍的写法。
    ...(process.env.MATRIX_TOKEN ? { MATRIX_ACCESS_TOKEN: process.env.MATRIX_TOKEN } : {}),
    ...extra,
  };
}

/**
 * 在宿主机上跑一段 shell（bash -c）。**没有隔离**：能读宿主文件、偷环境变量之外的密钥文件。
 * 用 -c 而不是 -lc：登录 shell 会读 ~/.bash_profile，可能把我们刚过滤掉的环境变量又塞回来。
 * 只在配置 mode="host" 时走到这里，给本地开发省掉 docker 那一层。
 */
export async function runOnHost(cmd: string, opts: ShellRunnerOptions): Promise<ShellRunnerResult> {
  const trimmed = checkCmd(cmd);
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const r = await runGroup("bash", ["-c", trimmed], opts.timeoutMs, hostCwd(opts), hostEnv(opts));
  const timedOut = r.killed === true || r.signal === "SIGKILL";
  return {
    ok: r.code === 0 && !timedOut,
    code: r.code,
    output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars, opts.overflowFile).trim(), secs, timedOut),
  };
}

export interface SandboxArgvOptions extends ShellRunnerOptions {
  /** host 模式下 argv[0] 的替代启动器，例如 [node, /path/rb.mjs]；argv 其余部分原样传给它 */
  hostPrefix?: string[];
  /** 只对本次执行注入的环境变量（docker exec -e / host env） */
  execEnv?: Record<string, string>;
}

/**
 * 按 argv 直接执行（不过 shell）：模型拼不出 `; rm -rf`。
 * 用于沙盒里的 rb 客户端——docker 模式执行镜像里的 `rb`，host 模式执行仓库里的 docker/rb.mjs。
 */
export async function runSandboxArgv(argv: string[], opts: SandboxArgvOptions): Promise<ShellRunnerResult> {
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
      output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars, opts.overflowFile).trim(), secs, timedOut),
    };
  }

  const ready = await ensureSandboxContainer(opts);
  if (!ready.ok) throw new Error(ready.message);

  const envArgs = Object.entries(opts.execEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const exec = () => run(
    "docker",
    ["exec", ...envArgs, opts.container, "timeout", "-s", "KILL", String(secs), ...argv],
    opts.timeoutMs + 5000,
  );
  let r = await exec();
  if (execBroken(r) && (await rebuildContainer(opts))) r = await exec();
  const timedOut = r.code === 137 || r.code === 124;
  return {
    ok: r.code === 0,
    code: r.code,
    output: timeoutMark(clip(`${r.out}${r.err}`, opts.maxOutputChars, opts.overflowFile).trim(), secs, timedOut),
  };
}

/** 按 mode 分发：docker（默认，隔离）或 host（无隔离，开发用）。 */
export async function runShell(cmd: string, opts: ShellRunnerOptions): Promise<ShellRunnerResult> {
  return (opts.mode ?? "docker") === "host" ? runOnHost(cmd, opts) : runInDocker(cmd, opts);
}
