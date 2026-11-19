/** 网页直聊：独立 web 池的读写口。API 层只做鉴权和参数校验。 */
import crypto from "node:crypto";
import { Store } from "../core/db.ts";
import type { Hub } from "../core/hub.ts";
import type { WebChatSettings } from "../core/web-auth.ts";
import { fmtLocal } from "../core/time.ts";
import type { Pool } from "../types.ts";

export const WEB_PLATFORM = "web";

export function webPoolId(settings: WebChatSettings): string {
  return Store.poolIdFor(WEB_PLATFORM, settings.pool);
}

/** 网页池首次出现时补上；已存在则只更新标题。 */
export function ensureWebPool(store: Store, settings: WebChatSettings): Pool {
  return store.upsertPool(WEB_PLATFORM, settings.pool, "private", settings.title);
}

function senderOf(store: Store, m: { platform: string; sender_id: string; sender_name: string }): string {
  return store.userDisplayName(m.platform, m.sender_id) || m.sender_name;
}

export function listWebMessages(
  store: Store,
  settings: WebChatSettings,
  opts: { afterSeq?: number; limit?: number } = {},
) {
  const pool = ensureWebPool(store, settings);
  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 60;
  const after = Number(opts.afterSeq);
  const rows = Number.isFinite(after) && after > 0
    ? store.messagesAfter(pool.pool_id, after, limit)
    : store.recentMessages(pool.pool_id, limit);
  const messages = rows
    .filter((m) => !m.internal)
    .map((m) => ({
      seq: m.seq,
      ts: m.ts,
      local: fmtLocal(m.ts),
      from_self: !!m.from_self,
      sender: senderOf(store, m),
      text: m.text,
      meta: m.meta ?? null,
    }));
  const span = store.poolSpan(pool.pool_id);
  return {
    pool: store.poolAlias(pool.pool_id),
    title: settings.title,
    total: span.total,
    last_seq: messages.length ? messages[messages.length - 1].seq : after > 0 ? after : 0,
    messages,
  };
}

export interface SendWebMessageDeps {
  store: Store;
  hub: Hub;
  settings: WebChatSettings;
}

/** 把网页用户的一句话入池，交给调度器按私聊节奏唤醒 agent。 */
export function sendWebMessage(d: SendWebMessageDeps, text: string) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("消息不能为空");
  if (body.length > 4000) throw new Error("消息最多 4000 字");
  const pool = ensureWebPool(d.store, d.settings);
  const saved = d.hub.ingest({
    platform: WEB_PLATFORM,
    external_chat_id: pool.external_id,
    pool_kind: "private",
    pool_title: d.settings.title,
    msg_id: `web-in-${crypto.randomUUID()}`,
    sender_id: `web:${d.settings.username}`,
    sender_name: d.settings.username,
    ts: Date.now(),
    text: body,
    reply_to: null,
    mentions: [],
    is_mention_me: true,
    media_type: "text",
    from_self: false,
  });
  if (!saved) throw new Error("消息重复，已忽略");
  return {
    seq: saved.seq,
    ts: saved.ts,
    local: fmtLocal(saved.ts),
    message: {
      seq: saved.seq,
      ts: saved.ts,
      local: fmtLocal(saved.ts),
      from_self: false,
      sender: d.settings.username,
      text: saved.text,
    },
  };
}
