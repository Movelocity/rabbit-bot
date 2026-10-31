/** API token 的生成/读取，以及注入沙盒的环境变量。单独成文件，避免 api ↔ ops 循环依赖。 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.ts";

const TOKEN_ENV = "RABBIT_BOT_API_TOKEN";
const DEFAULT_PORT = 3738;

/** 读 token：环境变量优先，其次 data/run/api.token，都没有就生成一个并落盘（0600）。 */
export function resolveApiToken(cfg: Config): string {
  const fromEnv = process.env[TOKEN_ENV];
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  const file = path.join(cfg.dataDir, "run", "api.token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 16) return t;
  } catch { /* 首次启动还没有 */ }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** 注入容器/宿主 shell 的环境变量：容器里用 host.docker.internal，宿主上用 127.0.0.1。 */
export function apiEnv(cfg: Config, token: string): Record<string, string> {
  const port = cfg.api?.port ?? DEFAULT_PORT;
  const host = cfg.sandbox.shell.mode === "host" ? "127.0.0.1" : "host.docker.internal";
  return { RB_API_URL: `http://${host}:${port}`, RB_API_TOKEN: token };
}
