/**
 * 脚本共用的三件小事：解析参数、打开库、按约定输出。
 *
 * 刻意保持极薄——真正的规矩（怎么排计划、记忆存哪儿）在 src/core 里，
 * 这里只让每个脚本少写十行样板。新增能力时不该需要改这个文件。
 */
import path from "node:path";
import fs from "node:fs";
import { Store } from "../../src/core/db.ts";

export type Flags = Record<string, string | boolean | undefined>;
export interface Parsed { pos: string[]; flags: Flags }

/** 支持：位置参数、--k v、--k=v、裸 --flag；`--` 之后原样带走（给 sb run 这类要传命令的） */
export function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Flags = {};
  const dd = argv.indexOf("--");
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  const head = dd >= 0 ? argv.slice(0, dd) : argv;
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = head[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[body] = next; i++; }
    else flags[body] = true;
  }
  if (rest.length) pos.push(...rest);
  return { pos, flags };
}

export const str = (f: Flags, k: string): string | undefined => {
  const v = f[k];
  return v === undefined || v === true ? undefined : String(v);
};
export const num = (f: Flags, k: string): number | undefined => {
  const v = str(f, k);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
export const bool = (f: Flags, k: string): boolean => f[k] === true || f[k] === "true" || f[k] === "1";

const APP_ROOT = path.resolve(import.meta.dirname, "..", "..");

export function openStore(flags: Flags = {}): Store {
  const p = str(flags, "db") ?? process.env.RB_DB ?? path.join(APP_ROOT, "data", "rabbit-bot.db");
  if (!fs.existsSync(p)) throw new Error(`找不到数据库：${p}`);
  return new Store(p);
}

export function mustPool(store: Store, ref: string | undefined) {
  if (!ref) throw new Error("缺少池参数（先跑 pool-list 看有哪些）");
  const pool = store.resolvePool(ref);
  if (!pool) throw new Error(`未知的池 ${ref}`);
  return pool;
}

/** 测试要伪造时钟：模拟器里的「现在」不是真实的现在 */
export function now(flags: Flags): number {
  return num(flags, "now") ?? Date.now();
}

/** pm2 里的进程有这些变量，交互 shell 没有：从仓库外的 env 文件补 */
export function loadEnvFile(): void {
  const f = path.join(process.env.HOME ?? "", ".config", "rabbit-bot", "env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}

/**
 * 统一的出口：成功 {ok:true,data}；失败 {ok:false,error} + 退出码 1。
 * 失败一定要走这里，不要 console.log 完还退 0——调用方分不清「查到了空」和「查挂了」。
 */
export async function run(fn: (p: Parsed) => unknown | Promise<unknown>): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.help === true || parsed.pos[0] === "help") {
    console.log(USAGE);
    return;
  }
  try {
    const data = await fn(parsed);
    console.log(JSON.stringify({ ok: true, data }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: (e as Error).message }));
    process.exitCode = 1;
  }
}

/** 每个脚本自己覆盖：describe("...", "用法") */
let USAGE = "用法见 CLAUDE.md / 技能 rabbit-bot-cli";
export function describe(usage: string): void { USAGE = usage; }
