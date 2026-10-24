/**
 * 本地注入入口：只监听 127.0.0.1，用 token 鉴权，把一条文本消息塞进指定聊天池并触发唤醒。
 * 用途：别的进程（大肥鱼/脚本/定时任务）想让爱马士知道点什么，不用走飞书。
 * 安全底线：只听回环地址、token 缺失就整个不启动、body 有大小上限、不回传池内容。
 */
import http from "node:http";
import crypto from "node:crypto";
import type { Config } from "./config.ts";
import type { Hub } from "./core/hub.ts";
import type { Store } from "./core/db.ts";
import type { Logger } from "./core/logger.ts";

const MAX_BODY = 16 * 1024;
const MAX_TEXT = 4000;

export interface InjectDeps { cfg: Config; hub: Hub; store: Store; log: Logger }

const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/** 起本地入口；没有 token 就返回 null（fail-closed，不悄悄裸奔） */
export async function startInjectServer(d: InjectDeps): Promise<http.Server | null> {
  const token = process.env.POOLCHAT_INJECT_TOKEN;
  if (!token || token.length < 16) {
    d.log.warn("inject: 没配 POOLCHAT_INJECT_TOKEN（至少 16 位），本地入口不启动");
    return null;
  }
  const port = Number(d.cfg.inject?.port ?? 3737);

  const server = http.createServer((req, res) => {
    const reply = (code: number, obj: unknown) => {
      if (res.writableEnded) return;
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };

    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/inject") {
      return reply(404, { error: "只支持 POST /inject" });
    }
    if (!safeEqual(String(req.headers["x-poolchat-token"] ?? ""), token)) {
      d.log.warn(`inject: 拒绝了一个 token 不对的请求（${req.socket.remoteAddress}）`);
      return reply(401, { error: "token 不对" });
    }

    let raw = "";
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BODY) { aborted = true; reply(413, { error: "body 太大" }); req.destroy(); }
    });
    req.on("end", () => {
      if (aborted) return;
      let body: any;
      try { body = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "不是合法 JSON" }); }

      const text = String(body.text ?? "").trim();
      if (!text) return reply(400, { error: "text 不能为空" });
      if (text.length > MAX_TEXT) return reply(400, { error: `text 最多 ${MAX_TEXT} 字` });

      const sender = String(body.sender ?? "大肥鱼").trim().slice(0, 40) || "大肥鱼";
      const pool = body.pool ? d.store.resolvePool(String(body.pool)) : d.store.listPools()[0];
      if (!pool) return reply(404, { error: body.pool ? `没有这个池：${body.pool}` : "还没有任何聊天池" });

      try {
        const saved = d.hub.ingest({
          platform: pool.platform as any,
          external_chat_id: pool.external_id,
          pool_kind: pool.kind,
          msg_id: `inject-${crypto.randomUUID()}`,
          sender_id: `inject:${sender}`,
          sender_name: sender,
          ts: Date.now(),
          text,
          reply_to: null,
          mentions: [],
          is_mention_me: false,
          media_type: "text",
          from_self: false,
        });
        if (!saved) return reply(409, { error: "被判成重复消息" });
        return reply(200, { ok: true, pool: d.store.poolAlias(pool.pool_id), seq: saved.seq });
      } catch (e) {
        d.log.error(`inject: 入池失败 ${(e as Error).message}`);
        return reply(500, { error: "入池失败" });
      }
    });
    req.on("error", () => { if (!res.writableEnded) reply(400, { error: "读取请求失败" }); });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  }).catch((e) => {
    d.log.warn(`inject: 端口 ${port} 起不来（${(e as Error).message}），本地入口不可用`);
    return null;
  });

  if (server.listening) {
    d.log.info(`inject: 本地入口已开 http://127.0.0.1:${port}/inject（POST + X-Poolchat-Token）`);
    return server;
  }
  return null;
}
