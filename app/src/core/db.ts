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
  reason TEXT, why TEXT, wave_a REAL -- 判定当时的水位，调参只看这一列
);
CREATE INDEX IF NOT EXISTS idx_tide_day ON tide_events(day, pool_id, anchor_kind, kind);
CREATE TABLE IF NOT EXISTS plan_fires (plan_id INTEGER NOT NULL, fire_ts INTEGER NOT NULL, fired_at INTEGER NOT NULL, PRIMARY KEY(plan_id, fire_ts));
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL,
  source_pool_id TEXT NOT NULL, source_kind TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
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
  constructor(file: string) {
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
  insertMessage(m: InboundMessage): StoredMessage | null {
    if (this.hasMessage(m.platform, m.msg_id)) return null; // 重复投递：不产生任何副作用
    const pool = this.upsertPool(m.platform, m.external_chat_id, m.pool_kind, m.pool_title ?? "");
    const user_id = m.from_self ? null : this.resolveUser(m.platform, m.sender_id, m.sender_name);
    const r = this.db.prepare(`INSERT OR IGNORE INTO messages(pool_id,platform,msg_id,sender_id,sender_name,user_id,ts,text,reply_to,mentions,is_mention_me,media_type,from_self,attachment)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pool.pool_id, m.platform, m.msg_id, m.sender_id, m.sender_name, user_id, m.ts, m.text,
      m.reply_to, JSON.stringify(m.mentions), m.is_mention_me ? 1 : 0, m.media_type, m.from_self ? 1 : 0,
      m.attachment ? JSON.stringify(m.attachment) : null);
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
  recentMessages(poolId: string, n: number, beforeOrAtSeq = Number.MAX_SAFE_INTEGER): StoredMessage[] {
    return (this.db.prepare("SELECT * FROM messages WHERE pool_id=? AND seq<=? ORDER BY seq DESC LIMIT ?").all(poolId, beforeOrAtSeq, n) as any[]).map(rowToMsg).reverse();
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
    anchor_kind?: string | null; reason?: string | null; why?: string | null; wave_a?: number | null }) {
    this.db.prepare(`INSERT INTO tide_events(plan_id,pool_id,day,ts,kind,anchor_kind,reason,why,wave_a) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(e.plan_id ?? null, e.pool_id ?? null, e.day, e.ts, e.kind, e.anchor_kind ?? null, e.reason ?? null, e.why ?? null, e.wave_a ?? null);
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
