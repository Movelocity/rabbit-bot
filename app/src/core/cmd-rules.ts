/**
 * 命令风险分类：纯函数，不碰 IO、不执行任何东西。
 *
 * 判据不是「命令长得凶不凶」，是「错了能不能撤」。三层：
 *   safe —— 确认过只读，免审
 *   ask  —— 默认档；能改状态、能出网、或执行体看不见，都要人点头
 *   deny —— 不问，直接拒；提权、格式化、凭据、越界删除、外发
 *
 * 设计上刻意不做「危险关键字正则」：`rm -rf` 可以写成 python -c、
 * find -delete、base64 | sh。正则只做兜底，主干是「拆子命令 → 解析 argv
 * → 动词白名单 + 路径归属」。
 */

export type Verdict = "safe" | "ask" | "deny";

export interface RuleContext {
  /** 允许写/删的根目录（绝对路径，规范化后） */
  allowedRoots: string[];
  /** 相对路径的基准目录 */
  cwd: string;
  home: string;
  /** 主人点名免审的命令（配置 exec.shell.safeProgs），只给它真能做的事的边界 */
  extraSafe?: string[];
}

export interface VerdictResult {
  verdict: Verdict;
  why: string;
  /** 触发判定的那一段子命令，便于审批消息里指出来 */
  part?: string;
}

/** 确认过只读、且参数不带破坏性开关的动词 */
const SAFE_PROGS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "date", "df", "du",
  "whoami", "uname", "echo", "printf", "which", "type", "stat",
  "rg", "grep", "file", "basename", "dirname", "realpath", "cd",
  "jq", "sort", "uniq", "cut", "tr", "diff", "md5", "shasum",
]);

/** 执行体不在命令文本里：看不见它跑什么，一律要问 */
const OPAQUE_PROGS = new Set([
  "sh", "bash", "zsh", "fish", "dash",
  "python", "python3", "node", "deno", "bun", "ruby", "perl", "php",
  "eval", "source", ".", "xargs", "make", "env",
  "npm", "pnpm", "yarn", "npx", "pip", "pip3", "uv", "cargo", "go",
  "docker", "kubectl", "ssh", "git-crypt",
]);

/** 无条件 deny */
const DENY_PROGS = new Set([
  "sudo", "su", "doas", "mkfs", "mkfs.ext4", "mkfs.apfs", "dd",
  "chown", "chgrp", "shutdown", "reboot", "launchctl", "systemsetup",
]);

/** 凭据与密钥：无论白名单怎么写都不许读 */
const CRED_PATTERNS: RegExp[] = [
  /\/\.config\/rabbit-bot\/env$/,
  /\/\.ssh$/, /\/\.ssh\//,
  /\/\.hermes\/\.env$/,
  /\/\.hermes\/memories\//,
  /\/\.dsh\/\.matrix-token$/,
  /\/\.env$/,                       // 工作目录里的 .env 也算凭据
  /\.pem$/, /\.key$/, /id_rsa$/, /id_ed25519$/,
  /\/\.aws\/credentials$/, /\/\.netrc$/, /\/\.npmrc$/,
];

const WRITE_REDIRECT = /(^|[^>0-9&])>{1,2}(?!&)/;

/** 写进去等于没写的目标 */
const DEV_NULL = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** 写这些地方不可撤，直接 deny */
const SYS_ROOTS = ["/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/var/db", "/private/etc"];

/** 拆成子命令；标出是否有「执行体不可见」的构造（$() / 反引号 / heredoc） */
export function splitSubcommands(cmd: string): { parts: string[]; opaque: string | null } {
  const parts: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      buf += c;
      if (c === quote && cmd[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === "`" || (c === "$" && cmd[i + 1] === "(")) {
      return { parts: [], opaque: c === "`" ? "反引号" : "$()" };
    }
    if (c === ";" || c === "\n") { parts.push(buf); buf = ""; continue; }
    if (c === "&") {
      // 重定向里的 & 不是命令分隔符：`2>&1`、`>&2`、`&>` 都留在同一段里，
      // 否则 `2>&1` 会被拆出一个 `1`，分类器报「未登记的命令：1」——白名单里的命令也跟着被拦。
      if (cmd[i - 1] === ">" || cmd[i + 1] === ">") { buf += c; continue; }
      if (cmd[i + 1] === "&") { parts.push(buf); buf = ""; i++; continue; }
      parts.push(buf); buf = ""; continue;
    }
    if (c === "|") {
      if (cmd[i + 1] === "|") { parts.push(buf); buf = ""; i++; continue; }
      parts.push(buf); buf = ""; continue;
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return { parts: parts.filter((p) => p.trim()), opaque: null };
}

/** 简单的 shell 分词：去引号、处理反斜杠转义。够分类用，不做完整语法。 */
export function tokenize(part: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "\\") { buf += part[++i] ?? ""; continue; }
    if (/\s/.test(c)) { if (buf) { out.push(buf); buf = ""; } continue; }
    buf += c;
  }
  if (buf) out.push(buf);
  return out;
}

/** 规范化路径：展开 ~，接上 cwd，消掉 . 与 ..（不碰文件系统） */
export function resolvePath(p: string, ctx: RuleContext): string {
  let s = p.replace(/^\$\{HOME\}/, ctx.home).replace(/^\$HOME(?=\/|$)/, ctx.home);
  if (s === "~") s = ctx.home;
  else if (s.startsWith("~/")) s = ctx.home + s.slice(1);
  else if (!s.startsWith("/")) s = ctx.cwd + "/" + s;
  const segs: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") segs.pop();
    else segs.push(seg);
  }
  return "/" + segs.join("/");
}

function insideRoots(abs: string, roots: string[]): boolean {
  return roots.some((r) => abs === r || abs.startsWith(r.endsWith("/") ? r : r + "/"));
}

function credHit(argv: string[], ctx: RuleContext): string | null {
  for (const a of argv) {
    if (!a || a.startsWith("-")) continue;
    const abs = resolvePath(a, ctx);
    for (const re of CRED_PATTERNS) if (re.test(abs)) return abs;
  }
  return null;
}

/** git 只有这几个子命令算只读 */
const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "blame", "shortlog"]);

function classifyArgv(argv: string[], raw: string, ctx: RuleContext): VerdictResult {
  const prog = argv[0].split("/").pop() ?? argv[0];
  const part = raw.trim();

  if (DENY_PROGS.has(prog)) return { verdict: "deny", why: `禁止的命令：${prog}`, part };

  const cred = credHit(argv, ctx);
  if (cred) return { verdict: "deny", why: `碰凭据：${cred}`, part };

  // 写重定向：/dev/null 之类不算写；系统目录 deny；其余根外降为 ask
  if (WRITE_REDIRECT.test(raw)) {
    // 逐个看重定向目标：`> /dev/null 2>&1` 里真正写文件的是 /dev/null，
    // 而 `2>&1`/`1>&2` 只是复制文件描述符（纯数字，不落到文件）。
    const targets = [...raw.matchAll(/>{1,2}\s*([^\s;|&]+)/g)]
      .map((m) => m[1])
      .filter((t) => !/^\d+$/.test(t));
    for (const target of targets) {
      const abs = resolvePath(target, ctx);
      if (DEV_NULL.has(abs)) continue;              // 丢进黑洞，等于没写
      if (SYS_ROOTS.some((r) => abs === r || abs.startsWith(r + "/"))) {
        return { verdict: "deny", why: `往系统目录写：${abs}`, part };
      }
      if (!insideRoots(abs, ctx.allowedRoots)) {
        return { verdict: "ask", why: `往允许根外写：${abs}`, part };
      }
      return { verdict: "ask", why: "写文件（重定向）", part };
    }
  }

  if (prog === "chmod") {
    if (argv.some((a) => /^[0-7]?777$/.test(a) || /^[0-7]{4}$/.test(a) && a.endsWith("7"))) {
      return { verdict: "deny", why: "开放权限", part };
    }
    return { verdict: "ask", why: "改权限", part };
  }

  if (prog === "rm" || prog === "rmdir") {
    const targets = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (!targets.length) return { verdict: "ask", why: "没给目标", part };
    for (const t of targets) {
      const abs = resolvePath(t, ctx);
      if (!insideRoots(abs, ctx.allowedRoots)) return { verdict: "deny", why: `删允许根之外：${abs}`, part };
    }
    return { verdict: "ask", why: "删文件（在允许根内）", part };
  }

  if (prog === "find") {
    if (argv.some((a) => ["-delete", "-exec", "-execdir", "-ok"].includes(a))) {
      return { verdict: "ask", why: "find 带删除/执行", part };
    }
    return { verdict: "safe", why: "只列", part };
  }

  if (prog === "git") {
    const sub = argv[1] ?? "";
    if (GIT_READ.has(sub)) {
      if (argv.some((a) => /^--output/.test(a))) {
        return { verdict: "ask", why: `git ${sub} 会写文件`, part };
      }
      if (argv.some((a) => a === "--hard" || a === "-fdx" || a === "--force")) {
        return { verdict: "ask", why: `git ${sub} 带强制参数`, part };
      }
      return { verdict: "safe", why: `git ${sub} 只读`, part };
    }
    return { verdict: "ask", why: `git ${sub || "(无子命令)"} 会改状态`, part };
  }

  if (OPAQUE_PROGS.has(prog)) return { verdict: "ask", why: `执行体不可见：${prog}`, part };

  // 只读命令也会被参数改造成写盘 / 执行：这些开关一律降档
  const WRITING_FLAGS = ["-o", "--output", "--pre", "--pre-glob", "--in-place", "-i"];
  if (SAFE_PROGS.has(prog)) {
    const dirty = argv.find((a) => WRITING_FLAGS.includes(a) || /^--output=/.test(a));
    if (dirty) return { verdict: "ask", why: `${prog} 带了会写/执行的参数 ${dirty}`, part };
    return { verdict: "safe", why: `${prog} 只读`, part };
  }

  // 主人点名放行的工具：一个命令只做一件事、碰不到本地文件系统的那些。
  // 唯一例外：bucket 的 rm 删的是远端对象，删错了没回收站，仍然要问。
  if ((ctx.extraSafe ?? []).includes(prog)) {
    if (prog === "bucket" && (argv[1] ?? "") === "rm") {
      return { verdict: "ask", why: "删远端对象", part };
    }
    return { verdict: "safe", why: `${prog} 已登记免审`, part };
  }

  return { verdict: "ask", why: `未登记的命令：${prog}`, part };
}

/** 顶层入口 */
export function classify(cmd: string, ctx: RuleContext): VerdictResult {
  const { parts: rawParts, opaque } = splitSubcommands(cmd);
  if (opaque) return { verdict: "ask", why: `命令里含 ${opaque}，执行体看不见` };
  // `time` 只是计时外壳：剥掉它，按里面真正的命令判，否则 `time bucket put` 会被当未登记。
  // 注意剥完还要判剩下的，所以 `time rm -rf ~` 仍然是 refuse。
  const parts = rawParts.map((p) => p.replace(/^\s*(?:\/usr\/bin\/)?time\b\s*/, ""));

  // curl/wget 直接喂给 shell：不问，拒
  for (let i = 1; i < parts.length; i++) {
    const prevProg = (tokenize(parts[i - 1])[0] ?? "").split("/").pop();
    const curProg = (tokenize(parts[i])[0] ?? "").split("/").pop();
    if (["curl", "wget"].includes(prevProg ?? "") && ["sh", "bash", "zsh", "dash", "python", "python3", "node"].includes(curProg ?? "")) {
      return { verdict: "deny", why: "下载内容直接执行", part: parts[i] };
    }
  }

  // scp/rsync 推到远端
  for (const p of parts) {
    const argv = tokenize(p);
    const prog = (argv[0] ?? "").split("/").pop();
    if (["scp", "rsync"].includes(prog ?? "") && argv.some((a) => /^[^/]*@[^/]+:/.test(a))) {
      return { verdict: "deny", why: "向远端主机外发文件", part: p };
    }
  }

  let worst: VerdictResult = { verdict: "safe", why: "全部子命令只读" };
  for (const p of parts) {
    const argv = tokenize(p);
    if (!argv.length) continue;
    const r = classifyArgv(argv, p, ctx);
    if (r.verdict === "deny") return r;
    if (r.verdict === "ask") worst = r;
  }
  return worst;
}
