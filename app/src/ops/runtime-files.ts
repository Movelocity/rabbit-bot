/** 运行时文本文件：人设与提示词，Web 管理台读写。 */
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, type Config } from "../config.ts";
import { runtimeHas, runtimePath } from "../core/runtime.ts";
import { DEFAULT_DIR, listTemplates, useRuntimePrompts } from "../agent/template.ts";

const REPO_PERSONA = path.resolve(APP_ROOT, "config/persona.md");
const PROMPT_NAME = /^[a-z][a-z0-9-]{0,40}$/;

export interface RuntimeFile {
  path: string;
  content: string;
  source: "runtime" | "repo" | "config";
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

export function readPersona(cfg: Config): RuntimeFile {
  const runtime = runtimePath(cfg, "persona.md");
  const runtimeText = readText(runtime);
  if (runtimeText !== null) return { path: runtime, content: runtimeText, source: "runtime" };
  const repoText = readText(REPO_PERSONA);
  if (repoText !== null) return { path: REPO_PERSONA, content: repoText, source: "repo" };
  return { path: "(config)", content: cfg.agent.persona, source: "config" };
}

export function writePersona(cfg: Config, content: string): RuntimeFile {
  if (typeof content !== "string") throw new Error("content 要是字符串");
  const runtime = runtimePath(cfg, "persona.md");
  atomicWrite(runtime, content);
  return readPersona(cfg);
}

function activePromptDir(cfg: Config): string {
  return runtimeHas(cfg, "prompt") ? runtimePath(cfg, "prompt") : DEFAULT_DIR;
}

function requirePromptName(name: string): string {
  const n = String(name ?? "").trim();
  if (!PROMPT_NAME.test(n)) throw new Error(`提示词名字不合法：${name}`);
  if (!listTemplates().includes(n)) throw new Error(`没有这个提示词：${n}`);
  return n;
}

export function readPrompt(cfg: Config, name: string): RuntimeFile {
  const n = requirePromptName(name);
  const dir = activePromptDir(cfg);
  const file = path.join(dir, `${n}.md`);
  const direct = readText(file);
  if (direct !== null) {
    return { path: file, content: direct, source: dir === DEFAULT_DIR ? "repo" : "runtime" };
  }
  const fallback = readText(path.join(DEFAULT_DIR, `${n}.md`));
  if (fallback !== null) return { path: path.join(DEFAULT_DIR, `${n}.md`), content: fallback, source: "repo" };
  throw new Error(`提示词文件不存在：${n}.md`);
}

export function writePrompt(cfg: Config, name: string, content: string): RuntimeFile {
  const n = requirePromptName(name);
  if (typeof content !== "string") throw new Error("content 要是字符串");
  const runtime = runtimePath(cfg, "prompt");
  if (!runtimeHas(cfg, "prompt")) fs.cpSync(DEFAULT_DIR, runtime, { recursive: true });
  const target = path.join(runtime, `${n}.md`);
  atomicWrite(target, content);
  useRuntimePrompts(cfg);
  return readPrompt(cfg, n);
}

export function listPrompts(cfg: Config): { name: string; source: "runtime" | "repo" }[] {
  const dir = activePromptDir(cfg);
  const source = dir === DEFAULT_DIR ? "repo" : "runtime";
  return listTemplates().map((name) => ({ name, source }));
}

/** 下次唤醒换新会话：让新 system prompt / 人设真正生效（旧会话的 system prompt 不会变）。 */
export function markFreshSession(cfg: Config): void {
  const dir = path.join(cfg.dataDir, "run");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "fresh-session"), new Date().toISOString(), "utf8");
}
