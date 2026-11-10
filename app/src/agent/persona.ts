/**
 * 人设正文：优先读运行时目录里的 `persona.md`（~/.config/rabbit-bot/runtime/persona.md），
 * 没配就用仓库里的默认份 `config/persona.md`，再没有才退回 `config.agent.persona`。
 *
 * 默认人设进仓库；个人的真身放运行时目录，不跟着代码走（见 core/runtime.ts）。
 *
 * 为什么不在启动时读一次：改人设要 `pm2 restart`，等于每调一次人格就中断一次对话。
 * 这里按 mtime 缓存，文件一变下一轮就用新的——人设是文本，不该需要重启进程。
 */
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, type Config } from "../config.ts";
import { runtimeHas, runtimePath } from "../core/runtime.ts";

const REPO_PERSONA_FILE = path.resolve(APP_ROOT, "config/persona.md");
const cache = new Map<string, { mtimeMs: number; size: number; text: string }>();

/** 当前实际用的人设文件：运行时目录有就优先 */
export function personaPath(cfg: Config): string {
  return runtimeHas(cfg, "persona.md") ? runtimePath(cfg, "persona.md") : REPO_PERSONA_FILE;
}

export function loadPersona(cfg: Config, file?: string): string {
  file = file ?? personaPath(cfg);
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
