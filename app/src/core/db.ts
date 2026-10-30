/** SQLite 存储：池、消息、游标、身份映射、计划、记忆、交接存档、唤醒日志、用量、开关。 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { InboundMessage, MemoryScope, Plan, PlanStatus, Pool, PoolKind, StoredMessage } from "../types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pools (
  pool_id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_msg_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(platform, external_id)
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, pool_id TEXT NOT NULL, platform TEXT NOT NULL, msg_id TEXT NOT NULL,
  sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, user_id TEXT, ts INTEGER NOT NULL, text TEXT NOT NULL,
  reply_to TEXT, mentions TEXT NOT NULL DEFAULT '[]', is_mention_me INTEGER NOT NULL DEFAULT 0,
  media_type TEXT NOT NULL DEFAULT 'text', from_self INTEGER NOT NULL DEFAULT 0, attachment TEXT,
  UNIQUE(platform, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_pool ON messages(pool_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_pool_ts ON messages(pool_id, ts);
CREATE TABLE IF NOT EXISTS cursors (pool_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS identities (
  platform TEXT NOT NULL, platform_user_id TEXT NOT NULL, user_id TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(platform, platform_user_id)
);
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', pool_id TEXT,
  schedule_kind TEXT NOT NULL, schedule TEXT, status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tide_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER, pool_id TEXT, day TEXT NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL, anchor_kind TEXT, anchor_ref TEXT, -- anchor_ref 已废弃（没有读者），列留着是因为 SQLite 删列要重建表
  reason TEXT, why TEXT, wave_a REAL, -- 判定当时的水位，调参只看这一列
  stage INTEGER -- 退潮第几档：0 = 首档，1.. = 每退一半一档
);
CREATE INDEX IF NOT EXISTS idx_tide_day ON tide_events(day, pool_id, anchor_kind, kind);
CREATE TABLE IF NOT EXISTS plan_fires (plan_id INTEGER NOT NULL, fire_ts INTEGER NOT NULL, fired_at INTEGER NOT NULL, PRIMARY KEY(plan_id, fire_ts));
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL,
  source_pool_id TEXT NOT NULL, source_kind TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'topic',
  pool_id TEXT, source TEXT NOT NULL DEFAULT '', -- 来源池 / 来源一句话（「他自己说的」）
  used_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_pick ON topics(retired, cooldown_until, used_count, last_used_at);
CREATE TABLE IF NOT EXISTS handoffs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, tokens INTEGER, content TEXT NOT NULL, file TEXT);
CREATE TABLE IF NOT EXISTS wake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, llm_calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

function rowToMsg(r: any): StoredMessage {
  return {
    seq: r.seq, pool_id: r.pool_id, platform: r.platform, msg_id: r.msg_id, sender_id: r.sender_id,
    sender_name: r.sender_name, user_id: r.user_id, ts: r.ts, text: r.text, reply_to: r.reply_to,
    mentions: JSON.parse(r.mentions), is_mention_me: !!r.is_mention_me, media_type: r.media_type, from_self: !!r.from_self,
    attachment: r.attachment ? JSON.parse(r.attachment) : null,
  };
}

export class Store {
  readonly db: Database.Database;
  /** 库文件路径：CLI 要用它指向同一个库（测试里是临时文件，线上是 data/rabbit-bot.db） */
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(SCHEMA);
    // 老库补列（新库已含在 SCHEMA 里）
    try { this.db.exec("ALTER TABLE messages ADD COLUMN attachment TEXT"); } catch { /* 已存在 */ }
    // 潮汐锚点（2026-10-24）：计划到点不一定该说，锚点决定能不能发
    // anchor_ref 保留仅为兼容旧库，代码不再读写
    for (const col of ["anchor_kind TEXT", "anchor_ref TEXT", "why TEXT"]) {
      try { this.db.exec(`ALTER TABLE plans ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
    // 水位场（2026-10-26）：判定当时的水位，调参只看这一列
    try { this.db.exec("ALTER TABLE tide_events ADD COLUMN wave_a REAL"); } catch { /* 已存在 */ }
    try { this.db.exec("ALTER TABLE tide_events ADD COLUMN stage INTEGER"); } catch { /* 已存在 */ }
    try { this.db.exec("ALTER TABLE messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0"); } catch { /* 已存在 */ }
  }
  close() { this.db.close(); }

  // ---------- kv / 开关 ----------
  getKv(k: string): string | undefined {
    return (this.db.prepare("SELECT v FROM kv WHERE k=?").get(k) as any)?.v;
  }
  setKv(k: string, v: string) {
    this.db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  }
  isPaused(): boolean { return this.getKv("paused") === "1"; }
  setPaused(p: boolean) { this.setKv("paused", p ? "1" : "0"); }

  // ---------- 池 ----------
  static poolIdFor(platform: string, externalId: string) { return `${platform}:${externalId}`; }
  upsertPool(platform: string, externalId: string, kind: PoolKind, title = ""): Pool {
    const pool_id = Store.poolIdFor(platform, externalId);
    this.db.prepare(`INSERT INTO pools(pool_id,platform,external_id,kind,title,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(pool_id) DO UPDATE SET title=CASE WHEN excluded.title<>'' THEN excluded.title ELSE pools.title END`)
      .run(pool_id, platform, externalId, kind, title, Date.now());
    return this.getPool(pool_id)!;
  }
  getPool(poolId: string): Pool | undefined {
    return this.db.prepare("SELECT pool_id,platform,external_id,kind,title FROM pools WHERE pool_id=?").get(poolId) as Pool | undefined;
  }
  /** 短别名 p<rowid>，给 LLM 用以节省 token */
  poolAlias(poolId: string): string {
    const r = this.db.prepare("SELECT rowid FROM pools WHERE pool_id=?").get(poolId) as any;
    return r ? `p${r.rowid}` : poolId;
  }
  /** 接受别名（p3）或完整 pool_id */
  resolvePool(ref: string): Pool | undefined {
    const m = /^p(\d+)$/.exec(ref.trim());
    if (m) return this.db.prepare("SELECT pool_id,platform,external_id,kind,title FROM pools WHERE rowid=?").get(Number(m[1])) as Pool | undefined;
    return this.getPool(ref.trim());
  }
  listPools(): (Pool & { last_msg_at: number })[] {
    return this.db.prepare("SELECT pool_id,platform,external_id,kind,title,last_msg_at FROM pools ORDER BY last_msg_at DESC").all() as any;
  }

  // ---------- 身份映射 ----------
  resolveUser(platform: string, platformUserId: string, displayName = ""): string {
    const row = this.db.prepare("SELECT user_id FROM identities WHERE platform=? AND platform_user_id=?").get(platform, platformUserId) as any;
    if (row) {
      if (displayName) this.db.prepare("UPDATE identities SET display_name=? WHERE platform=? AND platform_user_id=?").run(displayName, platform, platformUserId);
      return row.user_id;
    }
    const user_id = "u_" + crypto.randomUUID().slice(0, 8);
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO users(user_id,display_name,created_at) VALUES(?,?,?)").run(user_id, displayName, Date.now());
      this.db.prepare("INSERT INTO identities(platform,platform_user_id,user_id,display_name) VALUES(?,?,?,?)").run(platform, platformUserId, user_id, displayName);
    });
    tx();
    return user_id;
  }
  /** 把某平台账号并入已有 user_id（跨平台续聊）。 */
  linkIdentity(platform: string, platformUserId: string, userId: string) {
    this.db.prepare(`INSERT INTO identities(platform,platform_user_id,user_id) VALUES(?,?,?)
      ON CONFLICT(platform,platform_user_id) DO UPDATE SET user_id=excluded.user_id`).run(platform, platformUserId, userId);
    this.db.prepare("UPDATE messages SET user_id=? WHERE platform=? AND sender_id=?").run(userId, platform, platformUserId);
  }
  listIdentities(): any[] { return this.db.prepare("SELECT * FROM identities ORDER BY user_id").all(); }

  // ---------- 消息 ----------
  /** 入池；重复 msg_id 返回 null。 */
  insertMessage(m: InboundMessage & { internal?: boolean }): StoredMessage | null {
    if (this.hasMessage(m.platform, m.msg_id)) return null; // 重复投递：不产生任何副作用
    const pool = this.upsertPool(m.platform, m.external_chat_id, m.pool_kind, m.pool_title ?? "");
    const user_id = m.from_self ? null : this.resolveUser(m.platform, m.sender_id, m.sender_name);
    const r = this.db.prepare(`INSERT OR IGNORE INTO messages(pool_id,platform,msg_id,sender_id,sender_name,user_id,ts,text,reply_to,mentions,is_mention_me,media_type,from_self,attachment,internal)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pool.pool_id, m.platform, m.msg_id, m.sender_id, m.sender_name, user_id, m.ts, m.text,
      m.reply_to, JSON.stringify(m.mentions), m.is_mention_me ? 1 : 0, m.media_type, m.from_self ? 1 : 0,
      m.attachment ? JSON.stringify(m.attachment) : null, m.internal ? 1 : 0);
    if (r.changes === 0) return null;
    this.db.prepare("UPDATE pools SET last_msg_at=MAX(last_msg_at,?) WHERE pool_id=?").run(m.ts, pool.pool_id);
    return this.getMessageBySeq(Number(r.lastInsertRowid))!;
  }
  getMessageBySeq(seq: number): StoredMessage | undefined {
    const r = this.db.prepare("SELECT * FROM messages WHERE seq=?").get(seq);
    return r ? rowToMsg(r) : undefined;
  }
  hasMessage(platform: string, msgId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE platform=? AND msg_id=?").get(platform, msgId);
  }
  messagesAfter(poolId: string, afterSeq: number, limit = 200): StoredMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE pool_id=? AND seq>? ORDER BY seq LIMIT ?").all(poolId, afterSeq, limit) as any[]).map(rowToMsg);
  }
  /** 最近 n 条（seq<=beforeSeq），按时间正序返回 */
  /** 上下文用的最近消息：默认排掉 internal 的系统提示（它们不该进模型眼里）。 */
  recentMessages(poolId: string, n: number, beforeOrAtSeq = Number.MAX_SAFE_INTEGER, includeInternal = false): StoredMessage[] {
    const sql = includeInternal
      ? "SELECT * FROM messages WHERE pool_id=? AND seq<=? ORDER BY seq DESC LIMIT ?"
      : "SELECT * FROM messages WHERE pool_id=? AND seq<=? AND internal=0 ORDER BY seq DESC LIMIT ?";
    return (this.db.prepare(sql).all(poolId, beforeOrAtSeq, n) as any[]).map(rowToMsg).reverse();
  }
  maxSeq(poolId: string): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq),0) s FROM messages WHERE pool_id=?").get(poolId) as any).s;
  }
  /** 池规模：总条数 + 最早一条。给模型翻旧账时定位用。 */
  poolSpan(poolId: string): { total: number; first: StoredMessage | null; last: StoredMessage | null } {
    const total = (this.db.prepare("SELECT COUNT(*) c FROM messages WHERE pool_id=?").get(poolId) as any).c;
    const first = this.db.prepare("SELECT * FROM messages WHERE pool_id=? ORDER BY seq LIMIT 1").get(poolId) as any;
    const last = this.db.prepare("SELECT * FROM messages WHERE pool_id=? ORDER BY seq DESC LIMIT 1").get(poolId) as any;
    return { total, first: first ? rowToMsg(first) : null, last: last ? rowToMsg(last) : null };
  }
  /** 在池的历史消息里按关键词搜（LIKE，% 和 _ 已转义），新的在前。 */
  searchMessages(poolId: string, keyword: string, limit = 20, sender?: string): StoredMessage[] {
    const kw = `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const sql = `SELECT * FROM messages WHERE pool_id=? AND text LIKE ? ESCAPE '\\'${sender ? " AND sender_name=?" : ""} ORDER BY seq DESC LIMIT ?`;
    const args = sender ? [poolId, kw, sender, limit] : [poolId, kw, limit];
    return (this.db.prepare(sql).all(...args) as any[]).map(rowToMsg).reverse();
  }

  // ---------- 游标 ----------
  getCursor(poolId: string): number {
    return (this.db.prepare("SELECT last_seq FROM cursors WHERE pool_id=?").get(poolId) as any)?.last_seq ?? 0;
  }
  advanceCursor(poolId: string, seq: number) {
    this.db.prepare(`INSERT INTO cursors(pool_id,last_seq,updated_at) VALUES(?,?,?)
      ON CONFLICT(pool_id) DO UPDATE SET last_seq=MAX(cursors.last_seq,excluded.last_seq), updated_at=excluded.updated_at`).run(poolId, seq, Date.now());
  }
  /** 直接设置游标（LLM 调用失败时回滚用） */
  setCursor(poolId: string, seq: number) {
    this.db.prepare(`INSERT INTO cursors(pool_id,last_seq,updated_at) VALUES(?,?,?)
      ON CONFLICT(pool_id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at`).run(poolId, seq, Date.now());
  }
  /** 未读：游标之后、非自己发的消息 */
  unread(poolId: string, limit = 200): StoredMessage[] {
    return this.messagesAfter(poolId, this.getCursor(poolId), limit).filter((m) => !m.from_self);
  }
  poolsWithUnread(): string[] {
    return (this.db.prepare(`SELECT p.pool_id FROM pools p WHERE EXISTS (SELECT 1 FROM messages m WHERE m.pool_id=p.pool_id AND m.from_self=0
      AND m.seq > COALESCE((SELECT last_seq FROM cursors c WHERE c.pool_id=p.pool_id),0))`).all() as any[]).map((r) => r.pool_id);
  }

  // ---------- 计划 ----------
  insertPlan(p: Omit<Plan, "id" | "created_at" | "status" | "anchor_kind" | "why">
    & { status?: PlanStatus; anchor_kind?: string | null; why?: string | null }): Plan {
    const now = Date.now();
    const r = this.db.prepare(`INSERT INTO plans(title,content,pool_id,schedule_kind,schedule,status,expires_at,created_at,updated_at,anchor_kind,why) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.title, p.content, p.pool_id, p.schedule_kind, p.schedule, p.status ?? "pending", p.expires_at, now, now,
        p.anchor_kind ?? null, p.why ?? null);
    return this.getPlan(Number(r.lastInsertRowid))!;
  }

  /** 聊天活跃度（idle）用：最近窗口内的消息骨架，不带正文 */
  messagesForIdle(fromTs: number): { seq: number; ts: number; from_self: number }[] {
    return this.db.prepare("SELECT seq, ts, from_self FROM messages WHERE ts >= ? ORDER BY seq").all(fromTs) as any[];
  }

  // ---------- 潮汐 ----------
  /** 记一条潮汐事件：fired（真发了）/ skip（被闸门拦下）。没有 landed——响应率那套没实现，别在注释里假装有 */
  recordTideEvent(e: { plan_id?: number | null; pool_id?: string | null; day: string; ts: number; kind: string;
    anchor_kind?: string | null; reason?: string | null; why?: string | null; wave_a?: number | null; stage?: number | null }) {
    this.db.prepare(`INSERT INTO tide_events(plan_id,pool_id,day,ts,kind,anchor_kind,reason,why,wave_a,stage) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(e.plan_id ?? null, e.pool_id ?? null, e.day, e.ts, e.kind, e.anchor_kind ?? null, e.reason ?? null, e.why ?? null, e.wave_a ?? null, e.stage ?? null);
  }

  /**
   * 当天主动唤醒的用量：叫了几次、烧了多少 token。
   * 只统计带 proactive 的 tick（wake_log 里 reasons 提到水位），不含用户消息那一类。
   */
  proactiveUsage(fromTs: number, toTs: number): { wakes: number; tokens: number } {
    const rows = this.db.prepare("SELECT json FROM wake_log WHERE ts >= ? AND ts < ?").all(
      new Date(fromTs).toISOString(), new Date(toTs).toISOString(),
    ) as { json: string }[];
    let wakes = 0, tokens = 0;
    for (const r of rows) {
      try {
        const e = JSON.parse(r.json);
        const isProactive = e.type === "tick" && (e.reasons ?? []).some((x: string) => String(x).includes("水位"));
        if (!isProactive) continue;
        wakes += 1;
        tokens += Number(e.tokens ?? 0);
      } catch { /* 坏行跳过 */ }
    }
    return { wakes, tokens };
  }

  /**
   * 这段沉默里**问过**的档位（不管是发了还是没发）。
   *
   * 用途只有一个：同一档不要再问第二遍。少了这条，水位停在某一档时每个 tick
   * 都会再问一次——3 分钟一叫，10-27 夜里就是这么烧掉 200 万 token 的。
   */
  usedWaveStages(poolId: string | null, sinceTs: number): number[] {
    const rows = poolId === null
      ? this.db.prepare(`SELECT DISTINCT stage FROM tide_events WHERE stage IS NOT NULL AND ts >= ? AND kind IN ('fired','wave')`).all(sinceTs)
      : this.db.prepare(`SELECT DISTINCT stage FROM tide_events WHERE stage IS NOT NULL AND ts >= ? AND pool_id = ? AND kind IN ('fired','wave')`).all(sinceTs, poolId);
    return (rows as { stage: number }[]).map((r) => r.stage);
  }

  /**
   * 这段沉默里**真的开口过**几次（「没发」不算）。
   *
   * 用途：要不要继续给机会，看的是她开过几次口，不是水位退了几档。
   * 早先用「退到第几档 > maxStages」当上限，结果她连着憋几次、水位退到第 4 档后
   * 机制就再也不叫她（10-29 下午，从此四小时静默）——用「不主动」惩罚「不主动」。
   */
  firedWaveCount(poolId: string | null, sinceTs: number): number {
    const where =
      "stage IS NOT NULL AND ts >= ? AND kind IN ('fired','wave') AND COALESCE(reason,'') NOT LIKE '%没发%'";
    const row = poolId === null
      ? this.db.prepare(`SELECT COUNT(DISTINCT stage) AS n FROM tide_events WHERE ${where}`).get(sinceTs)
      : this.db.prepare(`SELECT COUNT(DISTINCT stage) AS n FROM tide_events WHERE ${where} AND pool_id = ?`).get(sinceTs, poolId);
    return Number((row as { n: number } | undefined)?.n ?? 0);
  }
  /** 水位场用：某池（null=跨池）在 [fromTs, toTs] 内的消息骨架，不含正文 */
  messagesForWave(poolId: string | null, fromTs: number, toTs: number): { ts: number; from_self: number }[] {
    if (poolId === null) {
      return this.db.prepare("SELECT ts, from_self FROM messages WHERE ts >= ? AND ts <= ? ORDER BY ts")
        .all(fromTs, toTs) as any[];
    }
    return this.db.prepare("SELECT ts, from_self FROM messages WHERE pool_id = ? AND ts >= ? AND ts <= ? ORDER BY ts")
      .all(poolId, fromTs, toTs) as any[];
  }
  /** ts 之前的最后一条消息。跨 tick 增量记账时要用它当「上一句是谁说的」，
   *  否则每个 tick 窗口里她说的第一条都会被当成「自己起的话头」扣 1 点而不是 0.1 */
  messageBefore(poolId: string | null, ts: number): { ts: number; from_self: number } | null {
    if (poolId === null) return null;
    const row = this.db.prepare(
      "SELECT ts, from_self FROM messages WHERE pool_id=? AND ts<? ORDER BY ts DESC LIMIT 1").get(poolId, ts);
    return (row as any) ?? null;
  }

  /** 池里她说的最后一条。主动判定拿它当基准：她一答完时钟就重新起步，
   *  用「任何人最后说话」的话，热聊时永远差几分钟，聊得越热主动机制越死 */
  lastSelfMessage(poolId: string | null): { ts: number } | null {
    if (poolId === null) return null;
    const row = this.db.prepare(
      "SELECT ts FROM messages WHERE pool_id=? AND from_self=1 ORDER BY ts DESC LIMIT 1").get(poolId);
    return (row as any) ?? null;
  }

  /** 池里最后一条消息（时间和是不是她说的），充能判定要用「最后谁说的话」 */
  lastMessage(poolId: string | null): { ts: number; from_self: number } | null {
    const row = poolId === null
      ? this.db.prepare("SELECT ts, from_self FROM messages ORDER BY ts DESC LIMIT 1").get()
      : this.db.prepare("SELECT ts, from_self FROM messages WHERE pool_id=? ORDER BY ts DESC LIMIT 1").get(poolId);
    return (row as any) ?? null;
  }

  /** 今天某个池、某一档已经真发了几条（L0 不占额度，不会问到这里） */
  countTideFired(day: string, poolId: string | null, anchorKind: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM tide_events WHERE day=? AND kind='fired' AND anchor_kind=? AND (pool_id IS ? OR pool_id=?)`)
      .get(day, anchorKind, poolId, poolId) as { n: number };
    return row.n;
  }
  recentTideEvents(limit = 20): any[] {
    return this.db.prepare(`SELECT * FROM tide_events ORDER BY id DESC LIMIT ?`).all(limit) as any[];
  }
  /** 上次真发主动是什么时候（给唤醒剧本用） */
  lastTideFired(poolId: string | null): { ts: number; why: string | null } | null {
    const r = this.db.prepare(`SELECT ts, why FROM tide_events WHERE kind='fired' AND (pool_id IS ? OR pool_id=?) ORDER BY ts DESC LIMIT 1`)
      .get(poolId, poolId) as { ts: number; why: string | null } | undefined;
    return r ?? null;
  }
  getPlan(id: number): Plan | undefined { return this.db.prepare("SELECT * FROM plans WHERE id=?").get(id) as Plan | undefined; }
  listPlans(status?: PlanStatus): Plan[] {
    return (status ? this.db.prepare("SELECT * FROM plans WHERE status=? ORDER BY id").all(status) : this.db.prepare("SELECT * FROM plans ORDER BY id").all()) as Plan[];
  }
  setPlanStatus(id: number, status: PlanStatus) {
    return this.db.prepare("UPDATE plans SET status=?, updated_at=? WHERE id=?").run(status, Date.now(), id).changes > 0;
  }
  /** 同一计划同一时间点只触发一次：插入成功才返回 true */
  recordPlanFire(planId: number, fireTs: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO plan_fires(plan_id,fire_ts,fired_at) VALUES(?,?,?)").run(planId, fireTs, Date.now()).changes > 0;
  }

  // ---------- 谈资（话题库） ----------
  // 和 memories 分开存：记忆是「对方说过的具体事实」，谈资是「可以拿来聊的东西」。
  // 混一张表的后果是话题把 maxMemoriesPerUser 的额度吃掉，真正该记住的事被挤出去。
  addTopic(t: { content: string; kind?: string; pool_id?: string | null; source?: string; now: number }): number {
    const r = this.db.prepare(
      "INSERT INTO topics(content,kind,pool_id,source,created_at) VALUES(?,?,?,?,?)",
    ).run(t.content, t.kind ?? "topic", t.pool_id ?? null, t.source ?? "", t.now);
    return Number(r.lastInsertRowid);
  }

  listTopics(o: { kind?: string; includeRetired?: boolean; limit?: number } = {}): any[] {
    const where = [o.includeRetired ? "1=1" : "retired=0"];
    const args: any[] = [];
    if (o.kind) { where.push("kind=?"); args.push(o.kind); }
    args.push(o.limit ?? 50);
    return this.db.prepare(
      `SELECT * FROM topics WHERE ${where.join(" AND ")} ORDER BY used_count ASC, COALESCE(last_used_at,0) ASC, id DESC LIMIT ?`,
    ).all(...args);
  }

  /** 这个池里最后一条消息的时间（任意一方）：给她「我们多久没说话了」的时间感 */
  lastMessageTs(poolId: string): number | null {
    const r = this.db.prepare("SELECT MAX(ts) AS t FROM messages WHERE pool_id = ?").get(poolId) as
      | { t: number | null }
      | undefined;
    return r?.t ?? null;
  }

  /**
   * 最近几次 wave 放行里，连着「放行了却没开口」有几次（从新往旧数，遇到发过的就停）。
   *
   * 用途：沉默要有重量。现在的语义是「放行＝她可以选择不说」，模型在自由时永远选最安全的，
   * 于是连着几次机会都白给。数到 2 就在 brief 里点她一句。
   */
  silentWaveStreak(poolId: string, cap = 5): number {
    const rows = this.db
      .prepare("SELECT reason FROM tide_events WHERE pool_id = ? AND kind = 'wave' ORDER BY ts DESC LIMIT ?")
      .all(poolId, cap) as { reason: string | null }[];
    let n = 0;
    for (const r of rows) {
      if (String(r.reason ?? "").includes("没发")) n++;
      else break;
    }
    return n;
  }

  /**
   * 挑几条可以聊的：悬置类（pending，他没回答的问题 / 答应过的事）先出，然后才轮到谈资。
   *
   * 之后的排序是用得最少的先出，同样少用就用最久没用的。
   * 刻意不让模型给话题打分——问它「这条重要吗」，它会把所有都打 5 分。
   * 行为信号（用过几次 / 多久没用）不会撒谎，也不需要额外问一次。
   */
  pickTopics(poolId: string | null, n: number, now: number): any[] {
    return this.db.prepare(
      `SELECT * FROM topics
        WHERE retired=0 AND cooldown_until <= ? AND (pool_id IS NULL OR pool_id = ?)
        ORDER BY CASE kind WHEN 'pending' THEN 0 ELSE 1 END,
                 used_count ASC, COALESCE(last_used_at,0) ASC, id DESC LIMIT ?`,
    ).all(now, poolId, n);
  }

  /** 用过就记账 + 进冷却，免得同一句话连着一周反复说 */
  markTopicUsed(id: number, now: number, cooldownDays = 7): boolean {
    return this.db.prepare(
      "UPDATE topics SET used_count = used_count + 1, last_used_at = ?, cooldown_until = ? WHERE id = ?",
    ).run(now, now + cooldownDays * 86400e3, id).changes > 0;
  }

  /** 每天最多新增几条——不封顶的话她一天能往里塞 50 条没人看的「梗」 */
  countTopicsAddedSince(sinceTs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM topics WHERE created_at >= ?").get(sinceTs) as { c: number }).c;
  }

  retireTopic(id: number): boolean {
    return this.db.prepare("UPDATE topics SET retired=1 WHERE id=?").run(id).changes > 0;
  }

  // ---------- 记忆 ----------
  addMemory(m: { user_id: string; kind?: string; content: string; source_pool_id: string; source_kind: PoolKind; scope: MemoryScope }) {
    return Number(this.db.prepare("INSERT INTO memories(user_id,kind,content,source_pool_id,source_kind,scope,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(m.user_id, m.kind ?? "fact", m.content, m.source_pool_id, m.source_kind, m.scope, Date.now()).lastInsertRowid);
  }
  /** 在 viewingPool 里能看到的某用户记忆（可见范围过滤） */
  visibleMemories(userId: string, viewingPool: Pool, limit: number): any[] {
    return this.db.prepare(`SELECT id,kind,content,source_pool_id,scope,created_at FROM memories WHERE user_id=? AND (
        scope='all' OR (scope='pool' AND source_pool_id=?) OR (scope='private' AND ?='private') OR (scope='group' AND ?='group')
      ) ORDER BY id DESC LIMIT ?`).all(userId, viewingPool.pool_id, viewingPool.kind, viewingPool.kind, limit);
  }

  // ---------- 交接 / 日志 / 用量 ----------
  addHandoff(content: string, tokens: number | null, file: string | null) {
    return Number(this.db.prepare("INSERT INTO handoffs(created_at,tokens,content,file) VALUES(?,?,?,?)").run(Date.now(), tokens, content, file).lastInsertRowid);
  }
  /** 上一次交接的时间（ms）。没有交接过就返回 0，表示「这个 session 从头算」。 */
  lastHandoffAt(): number {
    const r = this.db.prepare("SELECT created_at FROM handoffs ORDER BY id DESC LIMIT 1").get() as any;
    return Number(r?.created_at ?? 0);
  }

  /**
   * 上次交接之后一共烧了多少 token（含工具循环里每一轮）。
   * 上下文长度管不住总花费——128k 的窗口里，聊二十轮也能烧掉六十万，
   * 所以「这个 session 该换了」要用累计值来判断，不能看当前上下文。
   */
  tokensSince(ts: number): number {
    const rows = this.db.prepare("SELECT json FROM wake_log WHERE CAST(ts AS INTEGER) >= ?").all(ts) as { json: string }[];
    let sum = 0;
    for (const r of rows) {
      try { sum += Number(JSON.parse(r.json).tokens ?? 0); } catch { /* 坏行跳过 */ }
    }
    return sum;
  }

  latestHandoff(): { id: number; content: string } | undefined {
    return this.db.prepare("SELECT id,content FROM handoffs ORDER BY id DESC LIMIT 1").get() as any;
  }
  listHandoffs(): any[] { return this.db.prepare("SELECT id,created_at,tokens,file,length(content) len FROM handoffs ORDER BY id").all(); }
  addWakeLog(entry: unknown) { this.db.prepare("INSERT INTO wake_log(ts,json) VALUES(?,?)").run(Date.now(), JSON.stringify(entry)); }
  recentWakeLogs(n: number): any[] { return (this.db.prepare("SELECT json FROM wake_log ORDER BY id DESC LIMIT ?").all(n) as any[]).map((r) => JSON.parse(r.json)); }
  getUsage(day: string): { llm_calls: number; tokens: number; wakes: number } {
    return (this.db.prepare("SELECT llm_calls,tokens,wakes FROM usage_daily WHERE day=?").get(day) as any) ?? { llm_calls: 0, tokens: 0, wakes: 0 };
  }
  addUsage(day: string, calls: number, tokens: number, wakes = 0) {
    this.db.prepare(`INSERT INTO usage_daily(day,llm_calls,tokens,wakes) VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET
      llm_calls=llm_calls+excluded.llm_calls, tokens=tokens+excluded.tokens, wakes=wakes+excluded.wakes`).run(day, calls, tokens, wakes);
  }
}
