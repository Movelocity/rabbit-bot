/**
 * 宿主读取：白名单状态 + 判定 + 记录。
 *
 * 白名单目录三个来源：配置挂进沙盒的 volume、配置 readRoots、管理台加的（落 run/host-read-allow.json）。
 * 判定规则见 host-read-policy.ts；这里负责 realpath（防软链绕过）和读写状态文件。
 * 每次 host 读取（自动放行 / 批准 / 拒绝 / 超时 / 禁止）都记一行 host_read_log，管理台能回看。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "./db.ts";
import { expandHome } from "./platform.ts";
import { runtimeOverlays } from "./runtime.ts";
import {
  decideHostRead, type HostReadDecision, type HostReadRoot, type UnknownPolicy,
} from "./host-read-policy.ts";

const ALLOW_FILE = "host-read-allow.json";

export interface WebRoot { path: string; note: string; added_at: number }
interface AllowState { version: 2; unknown: UnknownPolicy; roots: WebRoot[] }

function expand(p: string): string {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  return path.resolve(expandHome(raw));
}

/**
 * 跟一遍软链。文件不存在时解析最近的已存在父目录再拼回去，
 * 否则 /var → /private/var 这类系统软链会让路径和白名单根对不上。
 */
export function realHostPath(p: string): string {
  const abs = expand(p);
  if (!abs) return abs;
  try { return fs.realpathSync(abs); } catch { /* 不存在，往上找 */ }
  let dir = path.dirname(abs);
  const tail = [path.basename(abs)];
  while (dir !== path.dirname(dir)) {
    try { return path.join(fs.realpathSync(dir), ...tail); } catch { /* 继续往上 */ }
    tail.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  return abs;
}

function allowFile(cfg: Config): string {
  return path.join(cfg.dataDir, "run", ALLOW_FILE);
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * 读状态文件。老格式是字符串数组（混着单文件和坏条目）：只留真实存在的目录，
 * 单个文件丢掉——代码/文档类型现在自动放行，不再需要逐个文件记。
 */
function readState(cfg: Config): AllowState {
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(allowFile(cfg), "utf8")); } catch { parsed = null; }
  if (Array.isArray(parsed)) {
    const now = Date.now();
    const roots = [...new Set(parsed.map((p) => expand(String(p))).filter((p) => p && isDir(p)))]
      .map((p) => ({ path: p, note: "从旧白名单迁移", added_at: now }));
    const st: AllowState = { version: 2, unknown: "ask", roots };
    try { writeState(cfg, st); } catch { /* 只读环境：下次再迁 */ }
    return st;
  }
  const o = (parsed ?? {}) as Partial<AllowState>;
  return {
    version: 2,
    unknown: o.unknown === "allow" ? "allow" : "ask",
    roots: Array.isArray(o.roots)
      ? o.roots.filter((r) => r && typeof r.path === "string" && r.path).map((r) => ({
        path: expand(r.path), note: String(r.note ?? ""), added_at: Number(r.added_at) || 0,
      }))
      : [],
  };
}

function writeState(cfg: Config, st: AllowState): void {
  const file = allowFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
}

/** 已经挂进沙盒的宿主目录同样算白名单（沙盒里能读，host scope 再读同一份不该再问）。 */
function volumeRoots(cfg: Config): string[] {
  const roots = (cfg.exec.shell.volumes ?? []).map((v) => expand(v.host));
  roots.push(...Object.values(runtimeOverlays(cfg)).map(expand));
  return roots.filter(Boolean);
}

export function hostReadRoots(cfg: Config): HostReadRoot[] {
  const out: HostReadRoot[] = [];
  const seen = new Set<string>();
  const push = (p: string, source: HostReadRoot["source"]) => {
    if (!p) return;
    const real = realHostPath(p);
    if (seen.has(real)) return;
    seen.add(real);
    out.push({ path: real, source });
  };
  for (const p of volumeRoots(cfg)) push(p, "volume");
  for (const p of cfg.exec.shell.host?.readRoots ?? []) push(expand(p), "config");
  for (const r of readState(cfg).roots) push(r.path, "web");
  return out;
}

export function hostReadSettings(cfg: Config): { unknown: UnknownPolicy; roots: Array<HostReadRoot & { note?: string; added_at?: number; exists: boolean }> } {
  const st = readState(cfg);
  const meta = new Map(st.roots.map((r) => [realHostPath(r.path), r]));
  return {
    unknown: st.unknown,
    roots: hostReadRoots(cfg).map((r) => ({
      ...r,
      ...(r.source === "web" ? { note: meta.get(r.path)?.note ?? "", added_at: meta.get(r.path)?.added_at ?? 0 } : {}),
      exists: isDir(r.path),
    })),
  };
}

export function setUnknownPolicy(cfg: Config, unknown: UnknownPolicy): void {
  const st = readState(cfg);
  st.unknown = unknown === "allow" ? "allow" : "ask";
  writeState(cfg, st);
}

export class HostReadRootError extends Error {}

/** 管理台加白名单目录：只收已存在的目录；根目录和家目录本身不收（等于全开）。 */
export function addHostReadRoot(cfg: Config, p: string, note = ""): WebRoot {
  const raw = String(p ?? "").trim();
  if (!raw || (!raw.startsWith("~") && !path.isAbsolute(raw))) throw new HostReadRootError("要绝对路径或 ~/...");
  const real = realHostPath(raw);
  if (!isDir(real)) throw new HostReadRootError(`不是已存在的目录：${real}`);
  if (real === path.parse(real).root || real === fs.realpathSync(os.homedir())) {
    throw new HostReadRootError("不收根目录或整个家目录，请选具体项目目录");
  }
  const st = readState(cfg);
  const existing = st.roots.find((r) => realHostPath(r.path) === real);
  if (existing) return existing;
  const row: WebRoot = { path: real, note: String(note ?? "").slice(0, 200), added_at: Date.now() };
  st.roots.push(row);
  writeState(cfg, st);
  return row;
}

/** 只能删管理台加的；配置来的要改配置文件 */
export function removeHostReadRoot(cfg: Config, p: string): boolean {
  const real = realHostPath(p);
  const st = readState(cfg);
  const next = st.roots.filter((r) => realHostPath(r.path) !== real && r.path !== expand(p));
  if (next.length === st.roots.length) return false;
  st.roots = next;
  writeState(cfg, st);
  return true;
}

/** 判定一个宿主路径：先 realpath，再按规则走。返回里带上真实路径。 */
export function checkHostRead(cfg: Config, target: string): HostReadDecision & { path: string } {
  const abs = realHostPath(target);
  const st = readState(cfg);
  const d = decideHostRead({
    abs,
    home: realHostPath(os.homedir()),
    roots: hostReadRoots(cfg),
    unknown: st.unknown,
    extraExts: cfg.exec.hostRead?.autoExts ?? [],
  });
  return { ...d, path: abs };
}

// ---------------------------------------------------------------- 记录

export type HostReadOutcome = "auto" | "approved" | "rejected" | "timeout" | "denied" | "unavailable";

export interface HostReadLogRow {
  id: number;
  ts: number;
  path: string;
  outcome: HostReadOutcome;
  rule: string;
  why: string;
  approval_id: number | null;
  by: string | null;
}

const LOG_KEEP = 5000;

export function logHostRead(store: Store | undefined, rec: Omit<HostReadLogRow, "id" | "ts"> & { ts?: number }): void {
  if (!store) return;
  try {
    const r = store.db.prepare(
      "INSERT INTO host_read_log(ts,path,outcome,rule,why,approval_id,by) VALUES(?,?,?,?,?,?,?)",
    ).run(rec.ts ?? Date.now(), rec.path, rec.outcome, rec.rule, rec.why, rec.approval_id ?? null, rec.by ?? null);
    // 每 200 条修一次剪：只留最近 LOG_KEEP 条
    const id = Number(r.lastInsertRowid);
    if (id % 200 === 0) store.db.prepare("DELETE FROM host_read_log WHERE id <= ?").run(id - LOG_KEEP);
  } catch { /* 记录失败不影响读取 */ }
}

export interface HostReadLogFilter {
  outcome?: string;
  q?: string;
  limit?: number;
  before?: number;
}

export function listHostReadLog(store: Store, f: HostReadLogFilter = {}): HostReadLogRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.outcome === "asked") where.push("outcome IN ('approved','rejected','timeout','unavailable')");
  else if (f.outcome) { where.push("outcome=?"); args.push(f.outcome); }
  if (f.q) { where.push("path LIKE ?"); args.push(`%${f.q}%`); }
  if (f.before) { where.push("id < ?"); args.push(f.before); }
  const limit = Math.min(500, Math.max(1, Math.floor(f.limit ?? 100)));
  return store.db.prepare(
    `SELECT * FROM host_read_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
  ).all(...args, limit) as HostReadLogRow[];
}

export function hostReadLogStats(store: Store, sinceMs: number): Record<string, number> {
  const rows = store.db.prepare(
    "SELECT outcome, COUNT(*) AS n FROM host_read_log WHERE ts >= ? GROUP BY outcome",
  ).all(sinceMs) as Array<{ outcome: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.outcome, Number(r.n)]));
}
