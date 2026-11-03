/**
 * 本地 REST API：把「池 / 计划 / 记忆 / 图片 / 联网 / 沙盒文件」暴露给沙盒里的技能脚本。
 *
 * 设计约束：
 *   - 只做宿主能力的出口，沙盒不挂库、不挂 scripts；
 *   - 所有请求必须带 Bearer token（token 自动生成到 data/run/api.token，并注入容器环境变量）；
 *   - 绑定地址由 config.api.host 决定（默认 0.0.0.0，容器才连得上，见 docs/sandbox-api.md）；
 *   - 返回体固定 {ok:true,data} / {ok:false,error}，和 CLI 的 JSON 约定一致。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./core/db.ts";
import type { Logger } from "./core/logger.ts";
import { listPools, readPool, searchPool } from "./ops/pools.ts";
import { addPlan, listPlans, updatePlan } from "./ops/plans.ts";
import { addMemory, searchMemories } from "./ops/memories.ts";
import { listImages, resolveImagePath } from "./ops/images.ts";
import { fetchWeb, searchWeb } from "./ops/web.ts";
import { listSandboxFiles, readSandboxFile, writeSandboxFile } from "./ops/sandbox.ts";
import { listSkills } from "./ops/skills.ts";

const MAX_BODY = 512 * 1024;
const DEFAULT_PORT = 3738;

export interface ApiDeps {
  cfg: Config;
  store: Store;
  log: Logger;
  token: string;
}

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BODY) {
        done = true;
        reject(new HttpError(413, `body 太大（上限 ${MAX_BODY} 字节）`));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (done) return;
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, "不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

const qInt = (v: string | null): number | undefined => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const qBool = (v: string | null): boolean => v === "1" || v === "true";

/** 起 API；cfg.api.enabled=false 时返回 null。 */
export async function startApiServer(d: ApiDeps): Promise<http.Server | null> {
  if (d.cfg.api?.enabled === false) return null;
  const port = d.cfg.api?.port ?? DEFAULT_PORT;
  const host = d.cfg.api?.host ?? "0.0.0.0";

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    const send = (code: number, obj: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    const reply = (code: number, data: unknown) => send(code, { ok: true, data });
    const fail = (code: number, error: string) => send(code, { ok: false, error });

    res.on("finish", () => d.log.info(`api ${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));

    // 健康检查不需要 token（只回状态，不含业务数据）
    if (method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      return reply(200, { status: "ok", sandbox: d.cfg.sandbox.shell.mode, time: Date.now() });
    }

    const auth = String(req.headers.authorization ?? "");
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-rabbit-bot-token"] ?? "");
    if (!safeEqual(bearer, d.token)) return fail(401, "token 不对");

    try {
      if (parts[0] !== "v1") throw new HttpError(404, "只支持 /v1/*");
      const body = ["POST", "PUT", "PATCH"].includes(method) ? await readBody(req) : {};

      switch (parts[1]) {
        case "pools": {
          if (parts.length === 2 && method === "GET") return reply(200, listPools(d.store));
          if (parts.length === 4 && parts[3] === "messages" && method === "GET") {
            return reply(200, readPool(d.store, parts[2], {
              limit: qInt(url.searchParams.get("limit")),
              beforeSeq: qInt(url.searchParams.get("before_seq")),
            }));
          }
          if (parts.length === 4 && parts[3] === "search" && method === "GET") {
            return reply(200, searchPool(
              d.store, url.searchParams.get("q") ?? "", parts[2], qInt(url.searchParams.get("limit")),
              (url.searchParams.get("only") as "self" | "other" | null) ?? undefined,
            ));
          }
          throw new HttpError(404, "用法：GET /v1/pools、/v1/pools/:ref/messages、/v1/pools/:ref/search?q=");
        }
        case "plans": {
          if (parts.length === 2 && method === "GET") return reply(200, listPlans(d.store, url.searchParams.get("status") ?? "pending"));
          if (parts.length === 2 && method === "POST") {
            return reply(201, addPlan(d.store, d.cfg.timezone, {
              title: body.title, content: body.content, kind: body.kind, when: body.when,
              pool: body.pool, anchor: body.anchor, why: body.why, expires: body.expires,
            }, typeof body.now === "number" ? body.now : undefined));
          }
          if (parts.length === 3 && method === "PATCH") {
            return reply(200, updatePlan(d.store, Number(parts[2]), String(body.status ?? "")));
          }
          throw new HttpError(404, "用法：GET /v1/plans、POST /v1/plans、PATCH /v1/plans/:id");
        }
        case "memories": {
          if (parts.length === 2 && method === "GET") {
            const all = url.searchParams.get("all");
            return reply(200, searchMemories(d.store, {
              user: url.searchParams.get("user") ?? undefined,
              pool: url.searchParams.get("pool") ?? undefined,
              limit: qInt(url.searchParams.get("limit")),
              at: url.searchParams.get("at") ?? undefined,
              all: all === "1" || all === "true",
            }));
          }
          if (parts.length === 2 && method === "POST") {
            return reply(201, addMemory(d.store, {
              user: body.user, content: body.content, pool: body.pool, kind: body.kind, scope: body.scope,
              from: body.from, until: body.until, supersede: body.supersede,
            }));
          }
          throw new HttpError(404, "用法：GET /v1/memories?user=&pool=[&at=ISO][&all=1]、POST /v1/memories");
        }
        case "images": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, listImages(d.store, d.cfg.dataDir, {
              source: url.searchParams.get("source") ?? undefined,
              page: qInt(url.searchParams.get("page")),
              size: qInt(url.searchParams.get("size")),
            }));
          }
          if (parts.length === 3 && parts[2] === "file" && method === "GET") {
            const abs = resolveImagePath(d.cfg.dataDir, url.searchParams.get("path") ?? "");
            const buf = fs.readFileSync(abs);
            res.writeHead(200, {
              "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
              "content-length": buf.length,
              "cache-control": "private, max-age=60",
            });
            return res.end(buf);
          }
          throw new HttpError(404, "用法：GET /v1/images、GET /v1/images/file?path=media/x.jpg");
        }
        case "web": {
          if (parts.length === 3 && parts[2] === "search" && method === "GET") {
            return reply(200, await searchWeb(url.searchParams.get("q") ?? "", {
              count: qInt(url.searchParams.get("count")),
              content: qBool(url.searchParams.get("content")),
            }));
          }
          if (parts.length === 3 && parts[2] === "fetch" && method === "POST") {
            return reply(200, await fetchWeb(String(body.url ?? "")));
          }
          throw new HttpError(404, "用法：GET /v1/web/search?q=、POST /v1/web/fetch {url}");
        }
        case "skills": {
          if (parts.length === 2 && method === "GET") {
            return reply(200, listSkills(d.cfg).map((s) => ({
              name: s.name,
              skill: `skills/${s.name}/SKILL.md`,
              data: `skills/${s.name}/data`,
              has_data: s.hasData,
            })));
          }
          throw new HttpError(404, "用法：GET /v1/skills");
        }
        case "sandbox": {
          // 只暴露文件区；`sb run` 不给 —— 技能脚本本来就在 shell 里
          if (parts.length === 3 && parts[2] === "files" && method === "GET") {
            return reply(200, listSandboxFiles(d.cfg, url.searchParams.get("path") ?? ""));
          }
          if (parts.length === 3 && parts[2] === "file" && method === "GET") {
            return reply(200, readSandboxFile(d.cfg, url.searchParams.get("path") ?? ""));
          }
          if (parts.length === 3 && parts[2] === "file" && method === "PUT") {
            return reply(200, writeSandboxFile(d.cfg, url.searchParams.get("path") ?? "", body.content));
          }
          throw new HttpError(404, "用法：GET /v1/sandbox/files?path=、GET|PUT /v1/sandbox/file?path=");
        }
        default:
          throw new HttpError(404, `没有这个接口：${url.pathname}`);
      }
    } catch (e) {
      const err = e as Error;
      const status = e instanceof HttpError ? e.status : 400;
      if (status >= 500) d.log.error(`api ${method} ${url.pathname} 失败`, e);
      return fail(status, err.message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  d.log.info(`api: 监听 ${host}:${actualPort}（沙盒用 http://host.docker.internal:${actualPort}）`);
  if (host === "0.0.0.0") d.log.warn("api: 绑定 0.0.0.0，局域网可访问，全靠 Bearer token 挡着");
  return server;
}
