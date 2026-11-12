import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { outputsDir } from "../core/runtime.ts";

export interface OutputEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  bytes?: number;
  mtime?: number;
}

export interface OutputNode {
  path: string;
  name: string;
  kind: "file" | "dir";
  bytes?: number;
  mtime?: number;
  children?: OutputNode[];
}

export interface OutputFile {
  path: string;
  name: string;
  ext: string;
  bytes: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 20000;
const MAX_TREE_DEPTH = 16;

export class OutputPathError extends Error {}

function rootDir(cfg: Config): string {
  const root = outputsDir(cfg);
  fs.mkdirSync(root, { recursive: true });
  return fs.realpathSync(root);
}

function inside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

function resolve(root: string, rel: string): string {
  if (typeof rel !== "string") throw new OutputPathError("路径不能为空");
  const norm = rel.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) throw new OutputPathError("只收相对路径");
  if (norm.split("/").includes("..")) throw new OutputPathError("不许用 ..");
  const abs = path.resolve(root, norm);
  if (!inside(root, abs)) throw new OutputPathError("跑到产出目录外面了");
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    if (!inside(root, real)) throw new OutputPathError("符号链接指向产出目录外");
    return real;
  }
  let q = path.dirname(abs);
  while (!fs.existsSync(q) && q !== path.dirname(q)) q = path.dirname(q);
  if (!inside(root, fs.realpathSync(q))) throw new OutputPathError("父目录指向产出目录外");
  return abs;
}

function sortEntries<T extends { kind: "file" | "dir"; name: string }>(out: T[]): T[] {
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN");
  });
}

export function listOutputs(cfg: Config, subdir = ""): OutputEntry[] {
  const root = rootDir(cfg);
  const dir = subdir ? resolve(root, subdir) : root;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new OutputPathError(`不是目录：${subdir}`);
  }
  const prefix = subdir.trim().replace(/^\/+|\/+$/g, "");
  const out: OutputEntry[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const stat = fs.statSync(abs);
    if (e.isDirectory()) {
      out.push({ path: rel, name: e.name, kind: "dir", mtime: stat.mtimeMs });
    } else if (e.isFile()) {
      out.push({ path: rel, name: e.name, kind: "file", bytes: stat.size, mtime: stat.mtimeMs });
    }
  }
  return sortEntries(out);
}

export function listOutputTree(cfg: Config): OutputNode[] {
  const root = rootDir(cfg);
  let count = 0;

  const walk = (dir: string, prefix: string, depth: number): OutputNode[] => {
    if (depth > MAX_TREE_DEPTH || count >= MAX_TREE_ENTRIES) return [];
    const out: OutputNode[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (count >= MAX_TREE_ENTRIES) break;
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const stat = fs.statSync(abs);
      if (e.isDirectory()) {
        count += 1;
        out.push({
          path: rel,
          name: e.name,
          kind: "dir",
          mtime: stat.mtimeMs,
          children: walk(abs, rel, depth + 1),
        });
      } else if (e.isFile()) {
        count += 1;
        out.push({ path: rel, name: e.name, kind: "file", bytes: stat.size, mtime: stat.mtimeMs });
      }
    }
    return sortEntries(out);
  };

  return walk(root, "", 0);
}

export function readOutput(cfg: Config, rel: string): OutputFile {
  if (!rel || !rel.trim()) throw new OutputPathError("缺少路径");
  const root = rootDir(cfg);
  const abs = resolve(root, rel);
  if (!fs.existsSync(abs)) throw new OutputPathError(`没有这个文件：${rel}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new OutputPathError(`不是文件：${rel}`);
  const bytes = stat.size;
  const fd = fs.openSync(abs, "r");
  let buf: Buffer;
  try {
    const readBytes = Math.min(bytes, MAX_PREVIEW_BYTES);
    buf = Buffer.alloc(readBytes);
    let offset = 0;
    while (offset < readBytes) {
      const n = fs.readSync(fd, buf, offset, readBytes - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    buf = buf.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
  const binary = buf.includes(0);
  return {
    path: rel.trim().replace(/\\/g, "/").replace(/^\.\/+/, ""),
    name: path.basename(abs),
    ext: path.extname(abs).slice(1).toLowerCase(),
    bytes,
    mtime: stat.mtimeMs,
    binary,
    truncated: bytes > MAX_PREVIEW_BYTES,
    content: binary ? "" : buf.toString("utf8"),
  };
}
