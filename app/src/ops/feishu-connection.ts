/**
 * 飞书凭据与适配器工厂：管理台写入的凭据落在 <dataDir>/secrets/feishu.json（0600），
 * 优先级高于环境变量；接口只回掩码，绝不回 App Secret。
 */
import fs from "node:fs";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import type { EmojiTable } from "../core/emoji.ts";
import type { Logger } from "../core/logger.ts";
import { filesDir, mediaInboxDir } from "../core/runtime.ts";
import { FeishuAdapter } from "../adapters/feishu.ts";

export type FeishuDomain = "feishu" | "lark";
export type CredentialSource = "runtime" | "env" | "none";

export interface EffectiveFeishuCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  source: CredentialSource;
  updatedAt: string | null;
}

export interface FeishuCredentialView {
  configured: boolean;
  credential_source: CredentialSource;
  app_id_masked: string | null;
  domain: FeishuDomain;
  updated_at: string | null;
}

interface StoredCredentials {
  app_id: string;
  app_secret: string;
  domain: FeishuDomain;
  updated_at: string;
}

export interface SaveFeishuInput {
  appId?: unknown;
  appSecret?: unknown;
  domain?: unknown;
}

export interface VerifyFeishuResult {
  ok: boolean;
  bot_name?: string;
  error?: string;
}

function secretsFile(cfg: Config): string {
  return path.join(cfg.dataDir, "secrets", "feishu.json");
}

function isDomain(v: unknown): v is FeishuDomain {
  return v === "feishu" || v === "lark";
}

function cleanText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 读运行时凭据；文件不存在或损坏返回 null（损坏只由调用方 warn，不能带出 secret）。 */
export function loadStoredFeishuCredentials(cfg: Config): StoredCredentials | null {
  const file = secretsFile(cfg);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const appId = cleanText(raw?.app_id);
    const appSecret = cleanText(raw?.app_secret);
    if (!appId || !appSecret) return null;
    return {
      app_id: appId,
      app_secret: appSecret,
      domain: isDomain(raw?.domain) ? raw.domain : cfg.adapters.feishu.domain,
      updated_at: cleanText(raw?.updated_at),
    };
  } catch {
    return null;
  }
}

export function hasStoredFeishuCredentials(cfg: Config): boolean {
  return !!loadStoredFeishuCredentials(cfg);
}

/** 生效凭据：管理台保存的优先，其次环境变量。 */
export function effectiveFeishuCredentials(cfg: Config): EffectiveFeishuCredentials {
  const stored = loadStoredFeishuCredentials(cfg);
  if (stored) {
    return {
      appId: stored.app_id,
      appSecret: stored.app_secret,
      domain: stored.domain,
      source: "runtime",
      updatedAt: stored.updated_at || null,
    };
  }
  const appId = cleanText(process.env.FEISHU_APP_ID);
  const appSecret = cleanText(process.env.FEISHU_APP_SECRET);
  if (appId && appSecret) {
    return {
      appId,
      appSecret,
      domain: cfg.adapters.feishu.domain,
      source: "env",
      updatedAt: null,
    };
  }
  return {
    appId: "",
    appSecret: "",
    domain: cfg.adapters.feishu.domain,
    source: "none",
    updatedAt: null,
  };
}

/** 掩码：只够用来核对是不是同一个应用，不能反推。 */
export function maskAppId(appId: string): string {
  const id = cleanText(appId);
  if (!id) return "";
  if (id.length <= 8) return `${id.slice(0, 2)}***`;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function feishuCredentialView(cfg: Config): FeishuCredentialView {
  const creds = effectiveFeishuCredentials(cfg);
  return {
    configured: creds.source !== "none",
    credential_source: creds.source,
    app_id_masked: creds.source === "none" ? null : maskAppId(creds.appId),
    domain: creds.domain,
    updated_at: creds.updatedAt,
  };
}

function validateAppId(raw: unknown): string {
  const id = cleanText(raw);
  if (!id) throw new Error("App ID 不能为空");
  if (id.length > 200) throw new Error("App ID 太长");
  if (/\s/.test(id)) throw new Error("App ID 不能包含空格");
  return id;
}

function validateAppSecret(raw: unknown): string {
  const secret = cleanText(raw);
  if (!secret) throw new Error("App Secret 不能为空");
  if (secret.length > 1000) throw new Error("App Secret 太长");
  if (/\s/.test(secret)) throw new Error("App Secret 不能包含空格");
  return secret;
}

/** 保存运行时凭据；secret 留空时只有已保存过 runtime 凭据才允许沿用。 */
export function saveFeishuCredentials(cfg: Config, input: SaveFeishuInput): EffectiveFeishuCredentials {
  const current = loadStoredFeishuCredentials(cfg);
  const appId = cleanText(input.appId) ? validateAppId(input.appId) : current?.app_id ?? "";
  if (!appId) throw new Error("App ID 不能为空");
  let appSecret = cleanText(input.appSecret);
  if (appSecret) appSecret = validateAppSecret(appSecret);
  else if (current?.app_secret) appSecret = current.app_secret;
  else throw new Error("App Secret 不能为空；环境变量里的凭据不会复制到本机文件");
  const domain = input.domain === undefined ? current?.domain ?? cfg.adapters.feishu.domain : input.domain;
  if (!isDomain(domain)) throw new Error("domain 只能是 feishu 或 lark");

  const stored: StoredCredentials = {
    app_id: appId,
    app_secret: appSecret,
    domain,
    updated_at: new Date().toISOString(),
  };
  const file = secretsFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* 某些文件系统不支持，不影响功能 */ }
  // 当前进程的配置也同步：domain 决定 SDK 连飞书还是 Lark
  cfg.adapters.feishu.domain = domain;
  return { appId, appSecret, domain, source: "runtime", updatedAt: stored.updated_at };
}

/** 删除运行时凭据，回退到环境变量；返回删除前是否存在。 */
export function clearFeishuCredentials(cfg: Config): boolean {
  const file = secretsFile(cfg);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** 用 tenant token + 机器人信息接口验证凭据；8 秒超时，错误只回摘要。 */
export async function verifyFeishuCredentials(
  appId: string,
  appSecret: string,
  domain: FeishuDomain,
): Promise<VerifyFeishuResult> {
  const client = new lark.Client({
    appId,
    appSecret,
    domain: domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const info: any = await Promise.race([
      client.request({ method: "GET", url: "/open-apis/bot/v3/info" }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("连接飞书超时（8s）")), 8000);
        timer.unref?.();
      }),
    ]);
    if (typeof info?.code === "number" && info.code !== 0) {
      return { ok: false, error: `飞书返回 code=${info.code} ${info.msg ?? ""}`.trim() };
    }
    const bot = info?.bot ?? {};
    return { ok: true, bot_name: cleanText(bot.app_name) || cleanText(bot.name) || undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "验证失败" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 按生效凭据造适配器；没凭据返回 null（管理台可以稍后连接）。 */
export function createFeishuAdapter(
  cfg: Config,
  deps: { store: Store; emoji: EmojiTable; log: Logger },
  creds: EffectiveFeishuCredentials = effectiveFeishuCredentials(cfg),
): FeishuAdapter | null {
  if (creds.source === "none") return null;
  return new FeishuAdapter(
    {
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: creds.domain,
      fetchSenderName: cfg.adapters.feishu.fetchSenderName,
      reactions: cfg.adapters.feishu.reactions,
      logRawEmoji: cfg.adapters.feishu.logRawEmoji,
      emoji: deps.emoji,
      media: { dir: mediaInboxDir(cfg), maxEdge: cfg.media.maxEdge, maxBytes: cfg.media.maxBytes },
      filesDir: filesDir(cfg),
      knownChats: () => deps.store.listPools({ includeArchived: true })
        .filter((p) => p.platform === "feishu")
        .map((p) => ({ id: p.external_id, kind: p.kind === "private" ? "private" as const : "group" as const, title: p.title })),
      isStored: (id) => deps.store.hasMessage("feishu", id),
    },
    deps.log,
  );
}