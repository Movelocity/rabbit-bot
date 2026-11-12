import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { runtimePath } from "./runtime.ts";

export const WORKING_MEMORY_FILE = "memory.md";
export const WORKING_MEMORY_MAX_CHARS = 4000;

export interface WorkingMemoryState {
  path: string;
  content: string;
  chars: number;
  limit: number;
  truncated: boolean;
}

const charLength = (s: string): number => Array.from(s).length;

function normalize(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

function readRaw(file: string): string {
  try {
    return normalize(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return "";
    throw e;
  }
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 2000;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 10_000) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("工作记忆正在被别的进程改写，稍后再试");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd!); } catch { /* ignore */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
  }
}

function assertWithinLimit(text: string): void {
  const n = charLength(text);
  if (n > WORKING_MEMORY_MAX_CHARS) {
    throw new Error(`工作记忆超过上限（${n}/${WORKING_MEMORY_MAX_CHARS} 字），先删掉过时内容再写。`);
  }
}

function formatEntry(content: string): string {
  return `- ${content.replace(/\n/g, "\n  ")}`;
}

export function workingMemoryPath(cfg: Config): string {
  return runtimePath(cfg, WORKING_MEMORY_FILE);
}

export function ensureWorkingMemory(cfg: Config): string {
  const file = workingMemoryPath(cfg);
  withLock(file, () => {
    if (!fs.existsSync(file)) atomicWrite(file, "");
  });
  return file;
}

export function readWorkingMemory(cfg: Config): WorkingMemoryState {
  const file = workingMemoryPath(cfg);
  const content = readRaw(file);
  const chars = charLength(content);
  return {
    path: file,
    content,
    chars,
    limit: WORKING_MEMORY_MAX_CHARS,
    truncated: chars > WORKING_MEMORY_MAX_CHARS,
  };
}

export function addWorkingMemory(cfg: Config, content: string): WorkingMemoryState {
  const text = String(content ?? "").trim();
  if (!text) throw new Error("content 不能为空");
  const file = workingMemoryPath(cfg);
  return withLock(file, () => {
    const current = readRaw(file);
    const entry = formatEntry(text);
    const next = current ? `${current}\n${entry}` : entry;
    assertWithinLimit(next);
    atomicWrite(file, `${next}\n`);
    return readWorkingMemory(cfg);
  });
}

export function replaceWorkingMemory(cfg: Config, oldText: string, content: string): WorkingMemoryState {
  const old = String(oldText ?? "").trim();
  const text = String(content ?? "").trim();
  if (!old) throw new Error("old 不能为空");
  if (!text) throw new Error("content 不能为空");
  const file = workingMemoryPath(cfg);
  return withLock(file, () => {
    const current = readRaw(file);
    const hits = current.split(old).length - 1;
    if (hits === 0) throw new Error(`工作记忆里没有找到「${old}」`);
    if (hits > 1) throw new Error(`「${old}」匹配到 ${hits} 处，写长一点让它唯一`);
    const next = current.replace(old, text);
    assertWithinLimit(next);
    atomicWrite(file, `${next}\n`);
    return readWorkingMemory(cfg);
  });
}

export function removeWorkingMemory(cfg: Config, oldText: string): { state: WorkingMemoryState; removed: number } {
  const old = String(oldText ?? "").trim();
  if (!old) throw new Error("old 不能为空");
  const file = workingMemoryPath(cfg);
  return withLock(file, () => {
    const current = readRaw(file);
    const lines = current ? current.split("\n") : [];
    const hits = lines.filter((line) => line.includes(old)).length;
    if (hits === 0) throw new Error(`工作记忆里没有找到「${old}」`);
    if (hits > 1) throw new Error(`「${old}」匹配到 ${hits} 行，写长一点让它唯一`);
    const kept = lines.filter((line) => !line.includes(old));
    const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    atomicWrite(file, next ? `${next}\n` : "");
    return { state: readWorkingMemory(cfg), removed: hits };
  });
}
