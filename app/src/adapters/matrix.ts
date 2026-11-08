/**
 * Matrix 适配器：homeserver 是自建的 Continuwuity（matrix.hollway.top）。
 *
 * 跟飞书适配器的分工一样：这里只做「平台消息 ↔ InboundMessage」的翻译，
 * 池的建立、去重、唤醒都在 Hub 里，不在这里。
 *
 * 长轮询 /sync 是唯一的事件来源——没有 webhook，所以不需要公网回调地址，
 * 也不怕重启丢消息：`since` 令牌存在 data/ 下，重启后从上次的位置接着读。
 */
import fs from "node:fs";
import path from "node:path";
import type { IMAdapter, SendResult } from "./types.ts";
import type { Attachment, InboundMessage, MediaType, PoolKind } from "../types.ts";
import type { Logger } from "../core/logger.ts";
import { saveFile, saveImage, type MediaOptions } from "../core/media.ts";

export interface MatrixOptions {
  homeserver: string; // https://matrix.hollway.top
  userId: string; // @xiaoyu:matrix.hollway.top
  accessToken: string;
  stateFile: string; // since 令牌落盘的位置
  /** 首次启动不回放历史（默认 true） */
  skipBacklog?: boolean;
  /** 图片落盘参数；不给就不下图片（只留占位文字） */
  media?: MediaOptions;
  /** 非图片附件落盘目录（沙箱内的 data/sandbox/files） */
  filesDir?: string;
}

interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content?: Record<string, unknown>;
  state_key?: string;
  unsigned?: { redacted_because?: unknown };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MatrixAdapter implements IMAdapter {
  readonly platform = "matrix" as const;
  private sink: ((m: InboundMessage) => void) | null = null;
  private since: string | null = null;
  private stopping = false;
  private txn = 0;
  private started = false;
  /** room_id → 是否私聊（成员数 ≤ 2）。首次见到房间时问一次，之后不再问 */
  private kindCache = new Map<string, PoolKind>();
  /** 事件串行队列：下载附件是异步的，顺序不能在池里错乱 */
  private queue: Promise<void> = Promise.resolve();
  private titleCache = new Map<string, string>();
  /** 已经问过 /joined_members 的房间，避免每轮 sync 都问一次 */
  private metaAsked = new Set<string>();
  private nameCache = new Map<string, string>();
  /** 有界去重窗口：since 令牌写盘失败时会重放一段历史，只靠令牌会重复入池 */
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private joined = new Set<string>();
  private inviteTasks = new Set<string>();
  private warnedEncrypted = new Set<string>();

  constructor(private opts: MatrixOptions, private log: Logger) {
    this.since = this.readSince();
  }

  // ---- 对外：生命周期 ----

  async start(sink: (m: InboundMessage) => void) {
    this.sink = sink;
    this.stopping = false;
    this.started = true;
    if (!this.since) await this.primeSince();
    void this.loop();
  }

  async stop() {
    this.stopping = true;
    this.sink = null;
  }

  // ---- 对外：发送 ----

  async sendText(roomId: string, text: string): Promise<SendResult> {
    // txnId 只需要在同一个房间内唯一；用「进程启动时刻 + 自增」保证重启后不撞
    const txn = `${Date.now().toString(36)}-${++this.txn}`;
    const r = await this.request("PUT", `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`, {
      msgtype: "m.text",
      body: text,
    });
    if (!r?.event_id) throw new Error(`Matrix 发送失败：${JSON.stringify(r).slice(0, 200)}`);
    return { msgId: r.event_id as string };
  }

  /** 我们自己的消息也会从 sync 回来，这一步等于「已经在聊天里了」 */
  async confirm(): Promise<boolean> {
    return true;
  }

  // ---- 内部：长轮询 ----

  private async loop() {
    let backoff = 1000;
    while (!this.stopping) {
      try {
        const q = new URLSearchParams({ timeout: "30000" });
        if (this.since) q.set("since", this.since);
        const data = await this.request("GET", `/sync?${q}`, null, 40_000);
        if (this.stopping) break;
        backoff = 1000;
        if (data?.next_batch) {
          this.since = data.next_batch as string;
          this.writeSince(this.since);
        }
        await this.handleSync(data);
      } catch (e) {
        if (this.stopping) break;
        const msg = e instanceof Error ? e.message : String(e);
        this.log.warn(`Matrix sync 失败，${Math.round(backoff / 1000)}s 后重试：${msg.slice(0, 160)}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** 首次启动：先拿一个 since 令牌，把历史甩掉（不然会把整个房间的历史都当新消息入池） */
  private async primeSince() {
    const data = await this.request("GET", "/sync?timeout=0", null, 30_000);
    if (data?.next_batch) {
      this.since = data.next_batch as string;
      this.writeSince(this.since);
      this.log.info(`Matrix 适配器就位：${this.opts.userId}（历史不回放）`);
    }
  }

  /**
   * 判私聊 + 取房间名：都是「问一次、缓存住」的东西。
   * 判错私聊的后果是实打实的——群聊要 @ 才唤醒，她就不会理人，看起来像没接上。
   */
  private async askRoomMeta(roomId: string, room: any) {
    this.metaAsked.add(roomId);
    try {
      const m = await this.request("GET", `/rooms/${encodeURIComponent(roomId)}/joined_members`, null, 10_000);
      const n = Object.keys(m?.joined ?? {}).length;
      if (n) this.kindCache.set(roomId, n <= 2 ? "private" : "group");
      if (!this.titleCache.has(roomId)) {
        const others = Object.keys(m?.joined ?? {}).filter((id) => id !== this.opts.userId);
        if (others.length === 1) {
          const nm = await this.nameOf(others[0]);
          if (nm) this.titleCache.set(roomId, nm);
        }
      }
    } catch (e) {
      this.log.warn(`Matrix 问房间成员失败 ${roomId}：${String(e).slice(0, 100)}`);
    }
    if (!this.titleCache.has(roomId)) {
      const name = room?.state?.events?.find?.((e: MatrixEvent) => e.type === "m.room.name")?.content?.name;
      if (name) this.titleCache.set(roomId, String(name));
    }
  }

  private async handleSync(data: any) {
    // 被邀请进新房间走的是 rooms.invite，不是 rooms.join——只遍历 join 会出现
    // 「拉她进群她没反应」：那些房间她还没加入，事件一条都不会进 timeline。
    for (const roomId of Object.keys(data?.rooms?.invite ?? {})) this.autoJoin(roomId);
    const rooms = data?.rooms?.join ?? {};
    for (const [roomId, room] of Object.entries<any>(rooms)) {
      const events: MatrixEvent[] = room?.timeline?.events ?? [];
      if (!events.length) continue;
      const summary = room?.summary ?? {};
      const members = summary["m.joined_member_count"];
      // 成员数 ≤ 2 当作私聊：Matrix 没有「私聊」这个概念，只能按人头判。
      // sync 里常常不带 summary（本机的 Continuwuity 就不带），那就问一次 /joined_members。
      if (typeof members === "number") this.kindCache.set(roomId, members <= 2 ? "private" : "group");
      else if (!this.metaAsked.has(roomId)) await this.askRoomMeta(roomId, room);
      // sync 里没有对方的 displayname；先补名字，否则池里看到的是一串 @xxx:host
      const unknown = events
        .filter((e) => e.type === "m.room.message" && !this.nameCache.has(e.sender))
        .map((e) => e.sender);
      if (unknown.length) await this.resolveNames([...new Set(unknown)]);
      for (const ev of events) this.enqueue(() => this.dispatch(roomId, ev, room));
    }
  }

  /** 事件按到达顺序串行处理：下载附件是异步的，乱序会让池里的图文对不上 */
  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(task).catch((e) => this.log.warn(`Matrix 处理事件失败：${String(e).slice(0, 120)}`));
  }

  private async dispatch(roomId: string, ev: MatrixEvent, room: any): Promise<void> {
    if (!this.sink) return;
    if (this.seenSet.has(ev.event_id)) return;
    this.rememberSeen(ev.event_id);
    if (ev.type === "m.room.member") {
      // 被拉进新房间就自己进去：不然她只能待在已经加入的房间里，别人请她也没反应
      if (String(ev.content?.membership ?? "") === "invite" && ev.state_key === this.opts.userId) this.autoJoin(roomId);
      return;
    }
    if (ev.type === "m.room.name" && ev.content?.name) {
      this.titleCache.set(roomId, String(ev.content.name));
      return;
    }
    if (ev.type === "m.room.encrypted") {
      // 我们没开 E2EE：加密房间能同步、没有任何报错，但消息一条都进不来——看起来连着，其实聋了
      if (!this.warnedEncrypted.has(roomId)) {
        this.warnedEncrypted.add(roomId);
        this.log.warn(`Matrix 房间 ${roomId} 的消息是加密的，本适配器不解密，这里收到的永远是空的`);
      }
      return;
    }
    if (ev.type === "m.reaction") {
      // 表情回复（审批用）：m.relates_to 里带被回复的事件 id 与表情本身。
      // 注意 key 常带 U+FE0F 变体选择符（"👍️"），归一化交给上面的闸门做。
      const rel = (ev.content?.["m.relates_to"] ?? {}) as {
        rel_type?: string;
        event_id?: string;
        key?: string;
      };
      if (rel.rel_type !== "m.annotation" || !rel.key) return;
      this.sink({
        platform: "matrix",
        external_chat_id: roomId,
        pool_kind: this.kindCache.get(roomId) ?? "group",
        pool_title: this.titleOf(roomId, room),
        msg_id: ev.event_id,
        sender_id: ev.sender,
        sender_name: this.nameCache.get(ev.sender) ?? this.shortName(ev.sender),
        ts: ev.origin_server_ts,
        text: rel.key,
        reply_to: null,
        mentions: [],
        is_mention_me: false,
        media_type: "reaction",
        from_self: this.isSelf(ev.sender),
        attachment: null,
        reaction_to: rel.event_id ?? null,
      });
      return;
    }
    if (ev.type !== "m.room.message") return;
    if (ev.unsigned?.redacted_because) return;
    const msgtype = String(ev.content?.msgtype ?? "");
    const media: MediaType | null =
      msgtype === "m.text" || msgtype === "m.notice" ? "text"
      : msgtype === "m.image" ? "image"
      : msgtype === "m.file" ? "file"
      : msgtype === "m.audio" ? "audio"
      : msgtype === "m.video" ? "video"
      : null;
    // 表情、位置、投票之类现在不处理：宁可当没看见，也不要塞一条「[未知消息]」进池
    if (!media) return;
    const body = String(ev.content?.body ?? "");
    const url = typeof ev.content?.url === "string" ? ev.content.url : "";
    const fromSelf = this.isSelf(ev.sender);
    const kind = this.kindCache.get(roomId) ?? "group";
    const mentions = (ev.content?.["m.mentions"] as { user_ids?: string[] } | undefined)?.user_ids ?? [];
    const isMentionMe = mentions.includes(this.opts.userId) || body.includes(this.opts.userId);
    const attachment = await this.attach(ev, media, url, body);
    this.sink({
      platform: "matrix",
      external_chat_id: roomId,
      pool_kind: kind,
      pool_title: this.titleOf(roomId, room),
      msg_id: ev.event_id,
      sender_id: ev.sender,
      sender_name: this.nameCache.get(ev.sender) ?? this.shortName(ev.sender),
      ts: ev.origin_server_ts,
      text: this.textOf(media, body, url, attachment),
      reply_to: (ev.content?.["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined)?.["m.in_reply_to"]?.event_id ?? null,
      mentions,
      is_mention_me: isMentionMe,
      media_type: media,
      from_self: fromSelf,
      attachment,
    });
  }

  /** 池里看到的那行字。附件下载成功时顺带给出她在沙箱里的路径。 */
  private textOf(media: MediaType, body: string, url: string, attachment: Attachment | null): string {
    const rel = attachment && this.opts.filesDir && media !== "image"
      ? path.relative(path.dirname(this.opts.filesDir), attachment.path)
      : "";
    // 「没下载下来」只在真去下了、且下失败时才说；没配落盘目录是另一回事
    const suffix = rel ? `（已存到 ${rel}）` : url && this.opts.filesDir ? "（没下载下来）" : "";
    if (media === "image") return `[图片${body ? `：${body}` : ""}]${url && !attachment && this.opts.media ? "（没下载下来）" : ""}`;
    if (media === "file") return `[文件：${body || "未命名"}]${suffix}`;
    if (media === "audio") return `[语音]${suffix}`;
    if (media === "video") return `[视频]${suffix}`;
    return body;
  }

  /**
   * 把附件从 homeserver 拉下来落盘。图片走 saveImage（压缩、喂模型），
   * 其它文件原样存进沙箱，她可以自己 read_file / terminal 打开。
   * 下载失败不算错误：文字里留「没下载下来」，她至少知道有这么个东西。
   */
  private async attach(ev: MatrixEvent, media: MediaType, url: string, body: string): Promise<Attachment | null> {
    if (media === "text" || !url) return null;
    try {
      if (media === "image") {
        if (!this.opts.media) return null;
        const raw = await this.download(url);
        return raw ? saveImage(raw, this.opts.media, ev.event_id) : null;
      }
      if (!this.opts.filesDir) return null;
      const raw = await this.download(url);
      if (!raw) return null;
      const saved = saveFile(raw, this.opts.filesDir, body || "file", ev.event_id);
      const mime = String((ev.content as any)?.info?.mimetype ?? "application/octet-stream");
      return { path: saved.path, mime, width: 0, height: 0, bytes: saved.bytes };
    } catch (e) {
      this.log.warn(`Matrix 附件落盘失败 ${url}：${String(e).slice(0, 120)}`);
      return null;
    }
  }

  /** mxc://server/mediaId → 字节。新老两个下载端点都试，老 homeserver 只认 v3。 */
  private async download(mxc: string): Promise<Buffer | null> {
    const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc);
    if (!m) return null;
    const [, server, id] = m;
    const paths = [
      `/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(id)}`,
      `/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(id)}`,
    ];
    for (const p of paths) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 60_000);
      try {
        const res = await fetch(`${this.opts.homeserver}${p}`, {
          headers: { Authorization: `Bearer ${this.opts.accessToken}` },
          signal: ac.signal,
        });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) continue; // 空响应当失败：0 字节的文件存下来只会骗自己
        return buf;
      } catch (e) {
        this.log.warn(`Matrix 下载 ${p} 失败：${String(e).slice(0, 100)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  }

  /**
   * 「这条是不是我自己发的」——宁可信其是。
   *
   * 判错的代价不对称：把自己的消息当成别人的，她就会回自己，无限循环（hall of mirrors）；
   * 把别人的消息当成自己的，最多丢一条（人会说第二遍）。所以拿不到自己的 id 时按「是」处理，
   * 并且比较前统一小写——homeserver 对 localpart 大小写的规范化不一致。
   */
  private isSelf(sender: string): boolean {
    const own = (this.opts.userId ?? "").trim().toLowerCase();
    if (!own) return true;
    return sender.trim().toLowerCase() === own;
  }

  private titleOf(roomId: string, room: any): string {
    const cached = this.titleCache.get(roomId);
    if (cached) return cached;
    const ev = (room?.state?.events ?? []).find((e: MatrixEvent) => e.type === "m.room.name");
    const name = ev?.content?.name ? String(ev.content.name) : "";
    if (name) this.titleCache.set(roomId, name);
    return name || `Matrix ${roomId.slice(1, 9)}`;
  }

  private rememberSeen(eventId: string) {
    this.seenSet.add(eventId);
    this.seen.push(eventId);
    if (this.seen.length > 1000) {
      const old = this.seen.shift();
      if (old) this.seenSet.delete(old);
    }
  }

  /** 进房间不在 sync 路径上等：join 慢一点没关系，卡住 sync 会让所有房间一起卡住 */
  private autoJoin(roomId: string) {
    if (this.joined.has(roomId) || this.inviteTasks.has(roomId)) return;
    this.inviteTasks.add(roomId);
    void (async () => {
      try {
        await this.request("POST", `/rooms/${encodeURIComponent(roomId)}/join`, {}, 15_000);
        this.joined.add(roomId);
        this.log.info(`Matrix 已加入房间 ${roomId}`);
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        // 死邀请（房间没了 / 服务器不认）会每次启动都重试，留着就是噪音：直接拒掉
        if (msg.includes("no servers") || msg.includes("room not found")) {
          await this.request("POST", `/rooms/${encodeURIComponent(roomId)}/leave`, {}).catch(() => {});
          this.log.info(`Matrix 拒掉一个进不去的邀请 ${roomId}`);
        } else {
          this.log.warn(`Matrix 加入房间失败 ${roomId}：${msg.slice(0, 120)}`);
        }
      } finally {
        this.inviteTasks.delete(roomId);
      }
    })();
  }

  /** 名字只用于显示；拿不到就退回 mxid 的前半段，别为它挡路 */
  private shortName(mxid: string) {
    return mxid.replace(/^@/, "").split(":")[0];
  }

  /** 补名字：sync 里不带对方的 displayname，得单独问；缓存住，一个房间只问几次 */
  private async nameOf(mxid: string): Promise<string | null> {
    await this.resolveNames([mxid]);
    return this.nameCache.get(mxid) ?? null;
  }

  async resolveNames(mxids: string[]) {
    for (const id of mxids) {
      if (this.nameCache.has(id)) continue;
      try {
        const r = await this.request("GET", `/profile/${encodeURIComponent(id)}`, null, 8000);
        const n = r?.displayname;
        this.nameCache.set(id, typeof n === "string" && n ? n : this.shortName(id));
      } catch {
        this.nameCache.set(id, this.shortName(id));
      }
    }
  }

  // ---- 内部：HTTP 与状态 ----

  private async request(method: string, apiPath: string, body?: object | null, timeoutMs = 20_000): Promise<any> {
    const url = `${this.opts.homeserver}/_matrix/client/v3${apiPath}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.accessToken}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(`${res.status} ${json?.errcode ?? ""} ${json?.error ?? text.slice(0, 120)}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private readSince(): string | null {
    try {
      return JSON.parse(fs.readFileSync(this.opts.stateFile, "utf8")).since ?? null;
    } catch {
      return null;
    }
  }

  private writeSince(since: string) {
    try {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      fs.writeFileSync(this.opts.stateFile, JSON.stringify({ since, at: Date.now() }));
    } catch (e) {
      this.log.warn(`Matrix since 令牌写盘失败（下次重启会重读一段历史）：${String(e).slice(0, 120)}`);
    }
  }
}
