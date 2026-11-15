export const TOKEN_KEY = "rabbit-bot.api-token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function apiRequest<T>(
  token: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  let body: Envelope<T> | null = null;
  try {
    body = text ? (JSON.parse(text) as Envelope<T>) : null;
  } catch {
    body = null;
  }

  if (res.status === 401) throw new ApiError(401, "token 不对或已失效");
  if (!res.ok || !body || body.ok !== true) {
    throw new ApiError(res.status, body?.error || `HTTP ${res.status}`);
  }
  return body.data as T;
}

export async function apiBlobRequest(
  token: string,
  path: string,
  opts: RequestOptions = {},
): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    cache: "no-store",
  });

  if (res.status === 401) throw new ApiError(401, "token 不对或已失效");
  if (!res.ok) {
    const text = await res.text();
    let message = "";
    try { message = (JSON.parse(text) as Envelope<unknown>).error ?? ""; } catch {}
    throw new ApiError(res.status, message || `HTTP ${res.status}`);
  }
  return res.blob();
}

export async function verifyToken(token: string): Promise<void> {
  await apiRequest<unknown>(token, "/v1/pools");
}

export function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {}
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export interface HealthResponse {
  status: string;
  exec: string;
  time: number;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("/health", { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as Envelope<HealthResponse> | HealthResponse;
    if ("ok" in body) return body.ok === true;
    return body.status === "ok";
  } catch {
    return false;
  }
}

export interface WebAuthStatus {
  enabled: boolean;
  username: string;
  agent: string;
  setup_required: boolean;
  authenticated: boolean;
  pool: string;
  title: string;
}

export interface WebLoginResult {
  token: string;
  username: string;
  expires_at: number;
}

/** 公共入口：不需要 token，用来决定显示登录还是首次设置密码。 */
export async function fetchWebAuthStatus(): Promise<WebAuthStatus> {
  return apiRequest<WebAuthStatus>("", "/v1/auth/status");
}

export async function setupWebPassword(password: string): Promise<WebLoginResult> {
  return apiRequest<WebLoginResult>("", "/v1/auth/setup", {
    method: "POST",
    body: { password },
  });
}

export async function loginWeb(username: string, password: string): Promise<WebLoginResult> {
  return apiRequest<WebLoginResult>("", "/v1/auth/login", {
    method: "POST",
    body: { username, password },
  });
}

export async function logoutWeb(token: string): Promise<void> {
  try {
    await apiRequest<unknown>(token, "/v1/auth/logout", { method: "POST" });
  } catch {
    // 退出是尽力而为：本地清掉 token 就够了
  }
}
