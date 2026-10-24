/**
 * 人设正文：优先读 `config/persona.md`，没有才退回 `config.agent.persona`。
 *
 * 为什么不在启动时读一次：改人设要 `pm2 restart`，等于每调一次人格就中断一次对话。
 * 这里按 mtime 缓存，文件一变下一轮就用新的——人设是文本，不该需要重启进程。
 */
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, type Config } from "../config.ts";

const PERSONA_FILE = path.resolve(APP_ROOT, "config/persona.md");
const cache = new Map<string, { mtimeMs: number; size: number; text: string }>();

export function personaPath(): string {
  return PERSONA_FILE;
}

export function loadPersona(cfg: Config, file = PERSONA_FILE): string {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = fs.readFileSync(file, "utf8").trim();
    if (!text) return cfg.agent.persona;
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    // 文件不存在 / 读不了：用 config 里的，别因为少了个人设文件就起不来
    return cfg.agent.persona;
  }
}
