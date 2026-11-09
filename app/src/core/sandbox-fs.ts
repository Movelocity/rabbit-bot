/**
 * 沙盒文件区：一个固定根目录 + 三条能力（列 / 读 / 写）。
 *
 * codemode 的 QuickJS 里没有文件系统（require/process/fetch 都是 undefined），
 * 所以「沙盒的根目录」不是 VM 的 cwd，而是宿主侧这几个工具的路径边界：
 * 所有路径都相对 root 解析，绝对路径、`..`、指向外部的符号链接一律拒绝。
 */
import fs from "node:fs";
import path from "node:path";

export interface SandboxEntry {
  path: string;
  kind: "file" | "dir";
  bytes?: number;
}

export interface SandboxFsOptions {
  /**
   * 允许符号链接指向这些根（共享技能库里的技能常常是软链）。
   * 默认空＝一律拒绝「链接指向沙盒外」，只有明确登记过的目录能穿过去。
   */
  trustedRoots?: string[];
  /** 根目录，绝对路径。不存在会创建。 */
  root: string;
  /** 单个文件上限（字节）。 */
  maxFileBytes: number;
  /** 根目录里最多多少个文件。 */
  maxFiles: number;
  /** 单次 read 返回的最大字符数（超出截断）。 */
  maxReadChars?: number;
  /**
   * 子目录覆盖：{ "prompt": "/abs/runtime/prompt" }。
   * 这些名字在运行时内容里（人设/话题库），真身在仓库外，但对她来说路径不变。
   */
  overlays?: Record<string, string>;
}

export class SandboxPathError extends Error {}

export interface SandboxFs {
  readonly root: string;
  list(sub?: string): SandboxEntry[];
  read(rel: string): string;
  write(rel: string, text: string): number;
}

export function createSandboxFs(opts: SandboxFsOptions): SandboxFs {
  const root = path.resolve(opts.root);
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const trustedRoots = (opts.trustedRoots ?? []).map((p) => {
    try { return fs.realpathSync(p); } catch { return ""; }
  }).filter(Boolean);
  const maxReadChars = opts.maxReadChars ?? 8000;

  const inside = (abs: string): boolean => abs === realRoot || abs.startsWith(realRoot + path.sep);

  /** 把调用方给的名字解析成根内绝对路径；越界一律抛 SandboxPathError。 */
  const resolve = (rel: string): string => {
    if (typeof rel !== "string" || !rel.trim()) throw new SandboxPathError("路径不能为空");
    const norm = rel.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) throw new SandboxPathError("只收相对路径");
    if (norm.split("/").includes("..")) throw new SandboxPathError("不许用 ..");

    // 运行时覆盖：第一段命中就整条改到那个根下面解析（安全检查一样不少）
    const seg = norm.split("/")[0];
    const ov = opts.overlays?.[seg];
    if (ov && fs.existsSync(ov)) {
      const ovRoot = fs.realpathSync(ov);
      const insideOv = (a: string) => a === ovRoot || a.startsWith(ovRoot + path.sep);
      const trusted = (a: string) => trustedRoots.some((r) => a === r || a.startsWith(r + path.sep));
      const absOv = path.resolve(ovRoot, norm.slice(seg.length + 1));
      if (!insideOv(absOv)) throw new SandboxPathError("跑到沙盒外面了");
      if (fs.existsSync(absOv)) {
        const real = fs.realpathSync(absOv);
        if (!insideOv(real) && !trusted(real)) throw new SandboxPathError("符号链接指向沙盒外");
        return real;
      }
      let q = path.dirname(absOv);
      while (!fs.existsSync(q) && q !== path.dirname(q)) q = path.dirname(q);
      if (!insideOv(fs.realpathSync(q))) throw new SandboxPathError("父目录指向沙盒外");
      return absOv;
    }

    const abs = path.resolve(realRoot, norm);
    if (!inside(abs)) throw new SandboxPathError("跑到沙盒外面了");
    if (fs.existsSync(abs)) {
      // 已存在：跟一遍符号链接，落点必须还在根内
      const real = fs.realpathSync(abs);
      if (!inside(real)) throw new SandboxPathError("符号链接指向沙盒外");
      return real;
    }
    // 待写：往上找到最近的已存在目录，它的 realpath 也必须在根内
    let p = path.dirname(abs);
    while (!fs.existsSync(p) && p !== path.dirname(p)) p = path.dirname(p);
    if (!inside(fs.realpathSync(p))) throw new SandboxPathError("父目录指向沙盒外");
    return abs;
  };

  const countFiles = (dir: string): number => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) n += countFiles(abs);
      else if (e.isFile()) n += 1;
    }
    return n;
  };

  return {
    root: realRoot,

    list(sub = ""): SandboxEntry[] {
      const dir = sub ? resolve(sub) : realRoot;
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new SandboxPathError(`不是目录：${sub}`);
      const out: SandboxEntry[] = [];
      const prefix = sub.trim().replace(/^\/+|\/+$/g, "");
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push({ path: rel, kind: "dir" });
        else if (e.isFile()) out.push({ path: rel, kind: "file", bytes: fs.statSync(abs).size });
      }
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },

    read(rel: string): string {
      const abs = resolve(rel);
      if (!fs.existsSync(abs)) throw new SandboxPathError(`没有这个文件：${rel}`);
      if (!fs.statSync(abs).isFile()) throw new SandboxPathError(`不是文件：${rel}`);
      const size = fs.statSync(abs).size;
      if (size > opts.maxFileBytes) throw new SandboxPathError(`文件太大（${size} 字节，上限 ${opts.maxFileBytes}）`);
      const text = fs.readFileSync(abs, "utf8");
      return text.length > maxReadChars ? `${text.slice(0, maxReadChars)}\n…（已截断，共 ${text.length} 字）` : text;
    },

    write(rel: string, text: string): number {
      const abs = resolve(rel);
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > opts.maxFileBytes) throw new SandboxPathError(`内容太大（${bytes} 字节，上限 ${opts.maxFileBytes}）`);
      const existed = fs.existsSync(abs);
      if (!existed && countFiles(realRoot) >= opts.maxFiles) {
        throw new SandboxPathError(`文件数已到上限 ${opts.maxFiles}，先清点再写`);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, "utf8");
      return bytes;
    },
  };
}
