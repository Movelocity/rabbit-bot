/**
 * Web 管理台的账号密码登录（网页直聊共用同一个登录态）。
 *
 * 设计取舍：
 *   - 只有一个账号（默认 rabbit-bot），够用就好；多账号不是这一版的目标。
 *   - 密码可以来自配置 / RABBIT_BOT_WEB_PASSWORD，也可以首次打开管理台时引导设置。
 *     设置后的哈希存 SQLite kv，明文不落盘、不写日志。
 *   - 登录态是随机不透明 token，存 kv（带过期时间），不是 JWT：
 *     服务端一删就失效，重启也不会把所有人踢下线。
 *   - 登录会话可以访问整个管理台和 /v1/webchat/*；脚本/任务继续用 RABBIT_BOT_API_TOKEN，
 *     两条通道互不影响。
 */
import crypto from "node:crypto";
import type { Config } from "../config.ts";
import type { Store } from "./db.ts";

const PASSWORD_KEY = "webchat.password.v1";
const SESSIONS_KEY = "webchat.sessions.v1";
const MIN_PASSWORD = 6;
const MAX_SESSIONS = 50;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

export interface WebChatSettings {
  enabled: boolean;
  username: string;
  /** 配置/环境变量里的明文密码（只用于比对，不落盘） */
  configuredPassword: string | null;
  /** 网页池 external_id（最终 pool_id = web:<pool>） */
  pool: string;
  title: string;
  sessionDays: number;
}

export interface WebSession {
  token: string;
  username: string;
  created_at: number;
  expires_at: number;
}

interface StoredSession { username: string; created_at: number; expires_at: number }

function passwordHash(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function passwordMatches(pw: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(pw, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

export function effectiveWebChat(cfg: Config): WebChatSettings {
  const raw = cfg.webChat ?? ({} as NonNullable<Config["webChat"]>);
  const envPw = String(process.env.RABBIT_BOT_WEB_PASSWORD ?? "").trim();
  const cfgPw = String(raw.password ?? "").trim();
  const days = Number(raw.sessionDays);
  return {
    enabled: raw.enabled !== false,
    username: String(raw.username ?? "").trim() || "rabbit-bot",
    configuredPassword: envPw || cfgPw || null,
    pool: String(raw.pool ?? "").trim() || "web-chat",
    title: String(raw.title ?? "").trim() || "网页直聊",
    sessionDays: Number.isFinite(days) && days > 0 ? Math.min(3650, Math.floor(days)) : 30,
  };
}

export class WebAuth {
  constructor(private store: Store, private cfg: Config) {}

  settings(): WebChatSettings {
    return effectiveWebChat(this.cfg);
  }

  /** 有没有可用的密码：配置里给了，或者首次引导已经设置过。 */
  hasPassword(): boolean {
    return !!this.settings().configuredPassword || !!this.store.getKv(PASSWORD_KEY);
  }

  setupRequired(): boolean {
    return !this.hasPassword();
  }

  private check(username: string, password: string): boolean {
    const s = this.settings();
    if (!s.enabled) return false;
    if (!safeEqual(username, s.username)) return false;
    if (s.configuredPassword) return safeEqual(password, s.configuredPassword);
    const stored = this.store.getKv(PASSWORD_KEY);
    return !!stored && passwordMatches(password, stored);
  }

  /**
   * 首次引导设置密码。配置里已经有密码时拒绝（以配置为准），
   * 已经设置过也拒绝，避免后到的人覆盖别人。
   */
  setup(password: string): WebSession {
    const s = this.settings();
    if (!s.enabled) throw new Error("Web 登录没有开启");
    if (s.configuredPassword) throw new Error("密码已在配置中指定，不能通过页面重新设置");
    if (this.store.getKv(PASSWORD_KEY)) throw new Error("密码已经设置过了，请直接登录");
    if (String(password ?? "").length < MIN_PASSWORD) {
      throw new Error(`密码至少 ${MIN_PASSWORD} 位`);
    }
    this.store.setKv(PASSWORD_KEY, passwordHash(password));
    return this.createSession(s.username);
  }

  login(username: string, password: string): WebSession | null {
    if (!this.check(String(username ?? "").trim(), String(password ?? ""))) return null;
    return this.createSession(this.settings().username);
  }

  createSession(username: string): WebSession {
    const s = this.settings();
    const now = Date.now();
    const rec: StoredSession = {
      username,
      created_at: now,
      expires_at: now + s.sessionDays * 86400e3,
    };
    const token = crypto.randomBytes(32).toString("base64url");
    const all = this.readSessions();
    all[token] = rec;
    const live = Object.entries(all)
      .filter(([, r]) => r.expires_at > now)
      .sort((a, b) => b[1].created_at - a[1].created_at)
      .slice(0, MAX_SESSIONS);
    this.writeSessions(Object.fromEntries(live));
    return { token, ...rec };
  }

  /** 校验登录 token；过期就顺手删掉，返回 null。 */
  verify(token: string): WebSession | null {
    const key = String(token ?? "").trim();
    if (!key) return null;
    const all = this.readSessions();
    const rec = all[key];
    if (!rec) return null;
    if (rec.expires_at <= Date.now()) {
      delete all[key];
      this.writeSessions(all);
      return null;
    }
    return { token: key, ...rec };
  }

  logout(token: string): void {
    const key = String(token ?? "").trim();
    if (!key) return;
    const all = this.readSessions();
    if (!(key in all)) return;
    delete all[key];
    this.writeSessions(all);
  }

  private readSessions(): Record<string, StoredSession> {
    const raw = this.store.getKv(SESSIONS_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, StoredSession> = {};
      for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const v = value as Record<string, unknown>;
        const created_at = Number(v.created_at);
        const expires_at = Number(v.expires_at);
        if (typeof v.username !== "string" || !Number.isFinite(created_at) || !Number.isFinite(expires_at)) continue;
        out[token] = { username: v.username, created_at, expires_at };
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeSessions(all: Record<string, StoredSession>): void {
    this.store.setKv(SESSIONS_KEY, JSON.stringify(all));
  }
}
