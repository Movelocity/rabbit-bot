/** 宿主读取白名单：配置挂进沙盒的 volume + readRoots + 主人审批过的路径。 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { expandHome, isInside } from "./platform.ts";
import { runtimeOverlays } from "./runtime.ts";

const ALLOW_FILE = "host-read-allow.json";

function expand(p: string): string {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  return path.resolve(expandHome(raw));
}

function allowFile(cfg: Config): string {
  return path.join(cfg.dataDir, "run", ALLOW_FILE);
}

/**
 * 已经挂进沙盒的宿主目录同样算白名单：模型在沙盒里能读，回到 host scope 读同一份
 * 内容不该再弹一次审批。runtime overlays 是 shellRunner 运行时追加的 volume，也要算。
 */
function configuredVolumeRoots(cfg: Config): string[] {
  const roots = (cfg.exec.shell.volumes ?? []).map((v) => expand(v.host));
  roots.push(...Object.values(runtimeOverlays(cfg)).map(expand));
  return roots.filter(Boolean);
}

export function hostReadRoots(cfg: Config): string[] {
  const roots = [
    ...configuredVolumeRoots(cfg),
    ...(cfg.exec.shell.host?.readRoots ?? []).map(expand).filter(Boolean),
  ];
  try {
    const parsed = JSON.parse(fs.readFileSync(allowFile(cfg), "utf8"));
    if (Array.isArray(parsed)) roots.push(...parsed.map((p) => expand(String(p))).filter(Boolean));
  } catch { /* 还没有白名单文件 */ }
  return [...new Set(roots)];
}

export function hostReadAllowed(cfg: Config, target: string): boolean {
  const abs = expand(target);
  return hostReadRoots(cfg).some((root) => isInside(root, abs));
}

export function rememberHostReadRoot(cfg: Config, target: string): void {
  const abs = expand(target);
  if (!abs) return;
  const roots = hostReadRoots(cfg);
  if (roots.some((root) => isInside(root, abs))) return;
  roots.push(abs);
  const file = allowFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...new Set(roots)], null, 2) + "\n", { mode: 0o600 });
}
