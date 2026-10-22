/**
 * 防死循环。
 * 首选社区扩展 pi-death-loop-guard（指纹 = 工具名 + 参数 + 结果），通过 LOOP_GUARD_* 环境变量配置为：
 *   连续 10 次一模一样 → 第 10 次被拦截并 ctx.abort() 结束本轮。
 * builtin 为同语义的代码实现（扩展不可用时自动回退，也用于单元测试）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
export function callKey(toolName: string, args: unknown) { return `${toolName}\u0000${JSON.stringify(sortKeys(args))}`; }
export function resultFp(content: { type: string; text?: string }[]) {
  const h = createHash("sha256");
  for (const c of content) h.update(c.type === "text" ? (c.text ?? "") : `#${c.type}`).update("\u0001");
  return h.digest("hex");
}

export interface LoopGuardConfig { warnThreshold: number; blockThreshold: number; abortAfterBlocks: number }

/** 纯逻辑：调用前 check()，结果后 record()；每轮开始 reset()。 */
export class LoopGuardCore {
  private lastKey: string | null = null;
  private lastFp: string | null = null;
  streak = 0;
  blocks = 0;
  private warned = false;
  constructor(private cfg: LoopGuardConfig) {}
  reset() { this.lastKey = this.lastFp = null; this.streak = 0; this.blocks = 0; this.warned = false; }
  /** 在工具执行前调用。返回 block（拦截）与 abort（结束本轮）。 */
  check(key: string): { block: boolean; abort: boolean } {
    if (key === this.lastKey && this.streak >= this.cfg.blockThreshold - 1) {
      this.blocks++;
      return { block: true, abort: this.blocks >= this.cfg.abortAfterBlocks };
    }
    return { block: false, abort: false };
  }
  /** 工具返回后调用。返回是否需要发出警告。 */
  record(key: string, fp: string): { warn: boolean } {
    if (key === this.lastKey && fp === this.lastFp) this.streak++;
    else { this.lastKey = key; this.lastFp = fp; this.streak = 1; this.warned = false; }
    if (this.streak === this.cfg.warnThreshold && !this.warned) { this.warned = true; return { warn: true }; }
    return { warn: false };
  }
}

/** builtin 版本的 pi 扩展工厂（与 pi-death-loop-guard 同语义） */
export function builtinLoopGuardExtension(cfg: LoopGuardConfig, onEvent?: (e: string) => void) {
  return (pi: any) => {
    const core = new LoopGuardCore(cfg);
    const pending = new Map<string, string>();
    pi.on("before_agent_start", () => { core.reset(); pending.clear(); });
    pi.on("tool_call", (ev: any, ctx: any) => {
      const key = callKey(ev.toolName, ev.input);
      const r = core.check(key);
      if (r.block) {
        onEvent?.(`loop-guard block ${ev.toolName}${r.abort ? " +abort" : ""}`);
        if (r.abort) ctx.abort();
        return { block: true, reason: `loop-guard: 连续 ${cfg.blockThreshold} 次完全相同的工具调用，已拦截并结束本轮。` };
      }
      pending.set(ev.toolCallId, key);
    });
    pi.on("tool_result", (ev: any) => {
      const key = pending.get(ev.toolCallId);
      pending.delete(ev.toolCallId);
      if (!key) return;
      if (core.record(key, resultFp(ev.content ?? [])).warn) {
        pi.sendMessage({ customType: "loop-guard-warning", content: `loop-guard: 你已连续 ${cfg.warnThreshold} 次以相同参数调用 ${ev.toolName} 且结果不变，请换个做法或结束本轮。`, display: false }, { deliverAs: "steer" });
      }
    });
  };
}

/** 解析社区扩展文件路径；不存在返回 null */
export function communityLoopGuardPath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("pi-death-loop-guard/package.json");
    const p = path.join(path.dirname(pkg), "extensions/loop-guard.ts");
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

/** 把配置写入社区扩展读取的环境变量（它只认 env）。 */
export function applyCommunityLoopGuardEnv(cfg: LoopGuardConfig) {
  process.env.LOOP_GUARD_ENABLED = "true";
  process.env.LOOP_GUARD_WARN_THRESHOLD = String(cfg.warnThreshold);
  process.env.LOOP_GUARD_BLOCK_THRESHOLD = String(cfg.blockThreshold);
  process.env.LOOP_GUARD_ABORT_THRESHOLD = String(cfg.abortAfterBlocks);
}
