/** 宿主读取白名单：配置里的根目录 + 主人审批过的路径。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.ts";

const ALLOW_FILE = "host-read-allow.json";

function expand(p: string): string {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  return path.resolve(raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw);
}

function allowFile(cfg: Config): string {
  return path.join(cfg.dataDir, "run", ALLOW_FILE);
}

export function hostReadRoots(cfg: Config): string[] {
  const roots = (cfg.exec.shell.host?.readRoots ?? []).map(expand).filter(Boolean);
  try {
    const parsed = JSON.parse(fs.readFileSync(allowFile(cfg), "utf8"));
    if (Array.isArray(parsed)) roots.push(...parsed.map((p) => expand(String(p))).filter(Boolean));
  } catch { /* 还没有白名单文件 */ }
  return [...new Set(roots)];
}

export function hostReadAllowed(cfg: Config, target: string): boolean {
  const abs = expand(target);
  return hostReadRoots(cfg).some((root) => abs === root || abs.startsWith(root + path.sep));
}

export function rememberHostReadRoot(cfg: Config, target: string): void {
  const abs = expand(target);
  if (!abs) return;
  const roots = hostReadRoots(cfg);
  if (roots.some((root) => abs === root || abs.startsWith(root + path.sep))) return;
  roots.push(abs);
  const file = allowFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...new Set(roots)], null, 2) + "\n", { mode: 0o600 });
}
