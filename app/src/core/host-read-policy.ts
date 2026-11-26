/**
 * 宿主读取判定：纯函数，不碰 IO。调用方先 realpath，再把绝对路径交进来。
 *
 * 顺序（先命中先算）：
 *   1. 硬禁区（私钥、钥匙串、本 bot 的 env）→ deny，审批也不给
 *   2. 疑似密钥 / 环境变量文件 → ask，白名单目录里也照样问；批准只放行这一次
 *   3. 白名单目录（配置 volume / readRoots / Web 加的）→ allow
 *   4. 代码、文档、常见文本数据类型 → allow
 *   5. 其他（数据库、无扩展名、二进制……）→ 按 unknown 策略（默认 ask）
 */
import path from "node:path";

export type HostReadVerdict = "allow" | "ask" | "deny";
export type UnknownPolicy = "ask" | "allow";

export interface HostReadRoot {
  path: string;
  /** config = 配置的 readRoots；volume = 挂进沙盒的目录；web = 管理台加的 */
  source: "config" | "volume" | "web";
}

export interface HostReadDecision {
  verdict: HostReadVerdict;
  /** 命中的规则：deny:ssh-key / secret:env / dir / ext / name / template / unknown */
  rule: string;
  why: string;
  /** rule=dir 时命中的白名单根 */
  root?: string;
}

/** 代码 / 文档 / 配置 / 文本数据：直接读 */
export const AUTO_EXTS = new Set([
  // 代码
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
  "go", "py", "pyi", "rb", "rs", "java", "kt", "kts", "scala", "groovy", "gradle", "swift", "m", "mm",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "php", "pl", "pm", "lua", "dart", "ex", "exs",
  "erl", "hrl", "clj", "cljs", "hs", "ml", "mli", "zig", "nim", "r", "jl", "sol", "proto", "thrift",
  "graphql", "gql", "sql", "prisma", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "css", "scss", "sass", "less", "styl", "html", "htm", "xml", "xsd", "xsl", "svg",
  "tf", "hcl", "nix", "cmake", "mk", "dockerfile",
  // 文档
  "md", "mdx", "markdown", "rst", "adoc", "txt", "text", "org", "tex",
  // 配置 / 数据文本
  "json", "jsonc", "json5", "jsonl", "ndjson", "yaml", "yml", "toml", "ini", "cfg", "conf",
  "properties", "csv", "tsv", "log", "lock", "sum", "mod", "diff", "patch", "editorconfig",
]);

/** 没扩展名但一眼能认的文件名 */
export const AUTO_NAMES = new Set([
  "dockerfile", "makefile", "gnumakefile", "jenkinsfile", "procfile", "vagrantfile", "gemfile",
  "rakefile", "podfile", "brewfile", "justfile", "license", "licence", "readme", "changelog",
  "authors", "contributors", "notice", "codeowners", "owners",
  ".gitignore", ".gitattributes", ".gitmodules", ".dockerignore", ".editorconfig", ".prettierrc",
  ".eslintrc", ".babelrc", ".nvmrc", ".node-version", ".python-version", ".tool-versions",
  ".npmignore", ".prettierignore", ".eslintignore", ".stylelintrc", ".browserslistrc",
]);

/** 模板后缀：`.env.example` 这类是给人抄的样板，不是真密钥 */
const TEMPLATE_SUFFIX = /\.(example|sample|template|tmpl|tpl|dist|defaults?)$/i;

/** 疑似密钥的扩展名 */
const SECRET_EXTS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk", "tfvars", "gpg", "age"]);

/** 疑似密钥的完整文件名 */
const SECRET_NAMES = new Set([
  ".netrc", "_netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", ".htpasswd", ".vault-token",
  ".boto", ".s3cfg", ".dockercfg", "credentials", "kubeconfig", "master.key", "id_rsa", "id_dsa",
  "id_ecdsa", "id_ed25519", "authorized_keys",
]);

/** 疑似密钥的文件名片段（按分隔符切，避免 tokenizer.ts 这种误伤） */
const SECRET_WORD = /(^|[._-])(secrets?|credentials?|private[_-]?key|service[_-]?account|api[_-]?keys?)([._-]|$)/i;

/** 路径里出现这些目录段，下面的东西都算密钥区 */
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".secrets", ".password-store", ".azure", ".gcloud"]);

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function under(root: string, abs: string): boolean {
  const r = root.endsWith(path.sep) ? root : root + path.sep;
  return abs === root || abs.startsWith(r);
}

/** 硬禁区：给了审批也不读 */
export function denyReason(abs: string, home: string): string | null {
  const name = path.basename(abs).toLowerCase();
  const ssh = path.join(home, ".ssh");
  if (under(ssh, abs) && /^id_[a-z0-9_]+$/.test(name)) return "SSH 私钥";
  if (under(path.join(home, ".gnupg", "private-keys-v1.d"), abs)) return "GPG 私钥";
  if (under(path.join(home, "Library", "Keychains"), abs)) return "系统钥匙串";
  if (abs === path.join(home, ".config", "rabbit-bot", "env")) return "本 bot 的凭据文件";
  if (/\/(Cookies|Login Data|Web Data)(-journal)?$/.test(abs)) return "浏览器登录数据";
  return null;
}

/**
 * 疑似密钥 / 环境变量文件；返回命中的原因，不是就返回 null。
 * 目录本身（如 ~/.ssh）也认，terminal 规则拿它判 `ls ~/.ssh`。
 */
export function secretReason(abs: string): string | null {
  const segs = abs.split(/[\\/]+/).filter(Boolean);
  const name = (segs[segs.length - 1] ?? "").toLowerCase();
  const dirHit = segs.find((s) => SECRET_DIRS.has(s.toLowerCase()));
  // 模板文件放行；但模板若在密钥目录里，照样按目录算
  if (TEMPLATE_SUFFIX.test(name) && !dirHit) return null;
  if (dirHit) return `密钥目录 ${dirHit}/`;
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env") || name === ".envrc") return "环境变量文件";
  if (SECRET_NAMES.has(name)) return `凭据文件 ${name}`;
  if (/^id_[a-z0-9]+$/.test(name)) return "SSH 私钥";
  if (SECRET_EXTS.has(ext(name))) return `密钥类型 .${ext(name)}`;
  if (SECRET_WORD.test(name.replace(/\.[^.]+$/, ""))) return "文件名像密钥";
  return null;
}

export interface DecideInput {
  /** 已 realpath 的绝对路径 */
  abs: string;
  home: string;
  roots: HostReadRoot[];
  unknown: UnknownPolicy;
  /** 配置里追加的自动放行扩展名（不带点） */
  extraExts?: string[];
}

export function decideHostRead(input: DecideInput): HostReadDecision {
  const { abs, home } = input;
  const deny = denyReason(abs, home);
  if (deny) return { verdict: "deny", rule: "deny", why: deny };

  const secret = secretReason(abs);
  if (secret) return { verdict: "ask", rule: "secret", why: secret };

  const root = input.roots.find((r) => under(r.path, abs));
  if (root) return { verdict: "allow", rule: "dir", why: `白名单目录（${root.source}）`, root: root.path };

  const name = path.basename(abs).toLowerCase();
  if (TEMPLATE_SUFFIX.test(name)) return { verdict: "allow", rule: "template", why: "模板文件" };
  if (AUTO_NAMES.has(name)) return { verdict: "allow", rule: "name", why: `常见文件 ${name}` };
  const e = ext(name);
  const extra = new Set((input.extraExts ?? []).map((x) => x.replace(/^\./, "").toLowerCase()));
  if (e && (AUTO_EXTS.has(e) || extra.has(e))) return { verdict: "allow", rule: "ext", why: `代码/文档 .${e}` };

  return input.unknown === "allow"
    ? { verdict: "allow", rule: "unknown", why: e ? `未登记类型 .${e}（策略：放行）` : "无扩展名（策略：放行）" }
    : { verdict: "ask", rule: "unknown", why: e ? `未登记类型 .${e}` : "无扩展名文件" };
}
