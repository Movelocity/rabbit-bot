/** SQLite 存储：池、消息、游标、身份映射、计划、记忆、交接存档、唤醒日志、用量、开关。 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  InboundMessage, MemoryScope, Plan, PlanStatus, Pool, PoolKind, Schedule, ScheduleKind, ScheduleStatus, StoredMessage,
} from "../types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pools (
  pool_id TEXT PRIMARY KEY, platform TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_msg_at INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', alias TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, pool_id TEXT NOT NULL,
  thought TEXT NOT NULL DEFAULT '', style_hint TEXT NOT NULL DEFAULT '',
  urgency REAL NOT NULL DEFAULT 0, topic_pick TEXT NOT NULL DEFAULT '', topic_angle TEXT NOT NULL DEFAULT '',
  next_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reflections_pool ON reflections(pool_id, created_at DESC);
CREATE TABLE IF NOT EXISTS proactive_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, pool_id TEXT NOT NULL,
  ts INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
  urgency REAL, silent_sec INTEGER, cooldown_req INTEGER, msg_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_proactive_ts ON proactive_log(ts DESC);
CREATE TABLE IF NOT EXISTS plan_fires (plan_id INTEGER NOT NULL, fire_ts INTEGER NOT NULL, fired_at INTEGER NOT NULL, PRIMARY KEY(plan_id, fire_ts));
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  pool_id TEXT,
  kind TEXT NOT NULL,
  cron TEXT,
  delay_minutes INTEGER,
  next_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, next_at);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL,
  source_pool_id TEXT NOT NULL, source_kind TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL,
  -- 时间维度：一条记忆说的是「什么时候的事」，不只是「什么时候记下的」
  valid_from INTEGER,      -- NULL = 从 created_at 开始成立
  valid_to INTEGER,        -- NULL = 至今有效
  superseded_by INTEGER,   -- 被哪一条顶掉（写法上等价于 valid_to = 那一条的时间）
  -- 对话索引：这条记忆是从哪段消息来的（seq 区间）。NULL = 老数据或管理台手写，回不到原文
  source_seq_start INTEGER,
  source_seq_end INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'topic',
  pool_id TEXT, source TEXT NOT NULL DEFAULT '', -- 来源池 / 来源一句话（「他自己说的」）
  used_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, cooldown_until INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_pick ON topics(retired, cooldown_until, used_count, last_used_at);
-- 知识库（2026-11-11）：可复用的业务知识，一篇一条；和记忆（单条事实）、业务地图（对象/关系）分开
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  object_id TEXT NOT NULL DEFAULT '',
  source_pool_id TEXT NOT NULL DEFAULT '',
  source_seq_start INTEGER,
  source_seq_end INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(retired, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_object ON knowledge(object_id);
-- 业务地图（2026-11-11）：从 runtime/business/*.json 搬进 SQLite，边是一等行
CREATE TABLE IF NOT EXISTS business_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS business_types (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS business_objects (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  key_kind TEXT, key_value TEXT, source_kind TEXT, source_value TEXT,
  aliases TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
  graph_id TEXT NOT NULL DEFAULT 'default', import_batch TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_business_objects_type ON business_objects(type);
CREATE TABLE IF NOT EXISTS business_relations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', from_type TEXT NOT NULL, to_type TEXT NOT NULL,
  cardinality TEXT, direction TEXT, risk TEXT, semantics TEXT,
  graph_id TEXT NOT NULL DEFAULT 'default', import_batch TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_business_relations_type ON business_relations(from_type);
CREATE TABLE IF NOT EXISTS business_edges (
  relation_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  evidence TEXT, updated_at INTEGER NOT NULL DEFAULT 0,
  graph_id TEXT NOT NULL DEFAULT 'default', import_batch TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(relation_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_business_edges_from ON business_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_business_edges_to ON business_edges(to_id);
CREATE TABLE IF NOT EXISTS business_actions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', applies_to TEXT NOT NULL DEFAULT '[]',
  risk TEXT, requires_relations TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS business_terms (
  term TEXT PRIMARY KEY, object_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS handoffs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, tokens INTEGER, content TEXT NOT NULL, file TEXT);
CREATE TABLE IF NOT EXISTS wake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_daily (day TEXT PRIMARY KEY, llm_calls INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0, cache_hit INTEGER NOT NULL DEFAULT 0, cache_miss INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'llm',
  model TEXT NOT NULL DEFAULT '',
  cache_hit INTEGER NOT NULL DEFAULT 0,
  cache_miss INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 1,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  pool_id       TEXT    NOT NULL,
  task_pool_id  TEXT    NOT NULL DEFAULT '',
  name          TEXT    NOT NULL DEFAULT '',
  goal          TEXT    NOT NULL,
  deliverable   TEXT    NOT NULL DEFAULT '',
  constraints   TEXT    NOT NULL DEFAULT '',
  acceptance    TEXT    NOT NULL DEFAULT '',
  files         TEXT    NOT NULL DEFAULT '[]',
  context       TEXT    NOT NULL DEFAULT '{}',
  status        TEXT    NOT NULL DEFAULT 'pending',
  stage         TEXT    NOT NULL DEFAULT '',
  worker_id     TEXT,
  claimed_at    INTEGER,
  lease_until   INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 0,
  note          TEXT    NOT NULL DEFAULT '',
  result        TEXT    NOT NULL DEFAULT '',
  artifact      TEXT    NOT NULL DEFAULT '',
  start_at      INTEGER NOT NULL,
  end_at        INTEGER,
  -- 任务执行方式（2026-11-09）：每个任务一个一次性进程，不再常驻 worker 轮询
  work_dir          TEXT    NOT NULL DEFAULT '',
  executor          TEXT    NOT NULL DEFAULT 'opencode',
  model             TEXT    NOT NULL DEFAULT '',
  session_id        TEXT    NOT NULL DEFAULT '',
  runner_pid        INTEGER,
  runner_started_at INTEGER,
  long_run_notified_at INTEGER,
  doc_path          TEXT    NOT NULL DEFAULT '',
  -- 执行耗费（2026-11-11）：进程退出时从 runner.jsonl 聚合 token / 费用 / 实际耗时
  exec_usage_at          INTEGER,
  exec_steps             INTEGER NOT NULL DEFAULT 0,
  exec_duration_ms       INTEGER NOT NULL DEFAULT 0,
  exec_total_tokens      INTEGER NOT NULL DEFAULT 0,
  exec_input_tokens      INTEGER NOT NULL DEFAULT 0,
  exec_output_tokens     INTEGER NOT NULL DEFAULT 0,
  exec_reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
  exec_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  exec_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  exec_cost_usd          REAL    NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_start ON tasks(start_at);
CREATE TABLE IF NOT EXISTS approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL,
  worker_id   TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  why         TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  decided_by  TEXT,
  decided_at  INTEGER,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
`;

function rowToPool(r: any): Pool & { last_msg_at?: number } {
  return {
    pool_id: r.pool_id, platform: r.platform, external_id: r.external_id, kind: r.kind,
    title: r.title, archived: !!r.archived, ...(r.last_msg_at === undefined ? {} : { last_msg_at: r.last_msg_at }),
  };
}

function rowToSchedule(r: any): Schedule {
  return {
    id: r.id, title: r.title, content: r.content,
    kind: r.kind as ScheduleKind, cron: r.cron ?? null, delay_minutes: r.delay_minutes ?? null,
    next_at: r.next_at, status: r.status as ScheduleStatus, last_fired_at: r.last_fired_at ?? null,
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

function rowToMsg(r: any): StoredMessage {
  return {
    seq: r.seq, pool_id: r.pool_id, platform: r.platform, msg_id: r.msg_id, sender_id: r.sender_id,
    sender_name: r.sender_name, user_id: r.user_id, ts: r.ts, text: r.text, reply_to: r.reply_to,
    mentions: JSON.parse(r.mentions), is_mention_me: !!r.is_mention_me, media_type: r.media_type, from_self: !!r.from_self,
    attachment: r.attachment ? JSON.parse(r.attachment) : null, internal: !!r.internal,
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
    // 池归档（2026-11-10）：归档后默认不出现在列表、不参与唤醒；来新消息自动解档
    try { this.db.exec("ALTER TABLE pools ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"); } catch { /* 已存在 */ }
    // 潮汐锚点（2026-10-24）：计划到点不一定该说，锚点决定能不能发
    // anchor_ref 保留仅为兼容旧库，代码不再读写
    for (const col of ["anchor_kind TEXT", "anchor_ref TEXT", "why TEXT"]) {
      try { this.db.exec(`ALTER TABLE plans ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
    // 水位场（2026-10-26）：判定当时的水位，调参只看这一列
    try { this.db.exec("ALTER TABLE tide_events ADD COLUMN wave_a REAL"); } catch { /* 已存在 */ }
    try { this.db.exec("ALTER TABLE tide_events ADD COLUMN stage INTEGER"); } catch { /* 已存在 */ }
    try { this.db.exec("ALTER TABLE messages ADD COLUMN internal INTEGER NOT NULL DEFAULT 0"); } catch { /* 已存在 */ }
    // 额度计算（2026-11-07）：缓存命中/未命中/输出三段分开记，cost_usd 是官方单价算出来的。
    // 老库补列，新库已在 SCHEMA 里。
    for (const col of [
      "cache_hit INTEGER NOT NULL DEFAULT 0",
      "cache_miss INTEGER NOT NULL DEFAULT 0",
      "out_tokens INTEGER NOT NULL DEFAULT 0",
      "cost_usd REAL NOT NULL DEFAULT 0",
    ]) {
      try { this.db.exec(`ALTER TABLE usage_daily ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
    // 用户别名（2026-11-09）：与飞书/通讯录自动名分开存，避免每条消息把人工别名冲掉
    try { this.db.exec("ALTER TABLE users ADD COLUMN alias TEXT NOT NULL DEFAULT ''"); } catch { /* 已存在 */ }
    // 逐次用量事件（2026-11-10）：老库补 calls 列；历史回填行保持默认 1，不做重算
    try { this.db.exec("ALTER TABLE usage_events ADD COLUMN calls INTEGER NOT NULL DEFAULT 1"); } catch { /* 已存在 */ }
    // 记忆时间维度（2026-11-03）：以前记忆是扁平快照，「想辞职」和「想升职」会一起活着
    for (const col of ["valid_from INTEGER", "valid_to INTEGER", "superseded_by INTEGER"]) {
      try { this.db.exec(`ALTER TABLE memories ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
    // 记忆来源索引（对话溯源）：记住写入时那批消息的 seq 区间。老数据留 NULL，不猜
    for (const col of ["source_seq_start INTEGER", "source_seq_end INTEGER"]) {
      try { this.db.exec(`ALTER TABLE memories ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
    // 任务面板（UFA-WA P0）：老库若已有 tasks 但没有 stage，补一列；失败不影响启动
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT ''"); } catch { /* 已存在 */ }
    // 短任务名（2026-11-09）：任务池标题用；老任务为空，展示时回退成 #任务<id>
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN name TEXT NOT NULL DEFAULT ''"); } catch { /* 已存在 */ }
    // worker 领任务（UFA-WA P1）：租约、归属、重试次数；新库已在 SCHEMA 里
    for (const col of ["worker_id TEXT", "claimed_at INTEGER", "lease_until INTEGER", "attempt INTEGER NOT NULL DEFAULT 0"]) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
    // 任务池（UFA-WA P4）：每条任务对应一个 platform=task 的聊天池；老库补列
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN task_pool_id TEXT NOT NULL DEFAULT ''"); } catch { /* 已存在 */ }
    // 业务地图上下文（2026-11-10）：任务涉及的对象/关系/禁止项；老库补列
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT '{}'"); } catch { /* 已存在 */ }
    // 一次性进程派发（2026-11-09）：工作目录、执行器、会话、runner 进程、任务文档；老库补列
    for (const col of [
      "work_dir TEXT NOT NULL DEFAULT ''",
      "executor TEXT NOT NULL DEFAULT 'opencode'",
      "model TEXT NOT NULL DEFAULT ''",
      "session_id TEXT NOT NULL DEFAULT ''",
      "runner_pid INTEGER",
      "runner_started_at INTEGER",
      "doc_path TEXT NOT NULL DEFAULT ''",
    ]) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
    // 业务地图图谱维度（2026-11-11）：对象/关系/边各自带 graph_id 与导入批次；老库补列
    for (const table of ["business_objects", "business_relations", "business_edges"]) {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN graph_id TEXT NOT NULL DEFAULT 'default'`); } catch { /* 已存在 */ }
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN import_batch TEXT NOT NULL DEFAULT ''`); } catch { /* 已存在 */ }
    }
    for (const table of ["business_objects", "business_relations", "business_edges"]) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_graph ON ${table}(graph_id)`);
    }
    // 长任务提醒（2026-11-11）：同一轮执行只提醒一次；老库补列
    try { this.db.exec("ALTER TABLE tasks ADD COLUMN long_run_notified_at INTEGER"); } catch { /* 已存在 */ }
    // 执行耗费（2026-11-11）：从 data/tasks/<id>/runner.jsonl 聚合；老库补列
    for (const col of [
      "exec_usage_at INTEGER",
      "exec_steps INTEGER NOT NULL DEFAULT 0",
      "exec_duration_ms INTEGER NOT NULL DEFAULT 0",
      "exec_total_tokens INTEGER NOT NULL DEFAULT 0",
      "exec_input_tokens INTEGER NOT NULL DEFAULT 0",
      "exec_output_tokens INTEGER NOT NULL DEFAULT 0",
      "exec_reasoning_tokens INTEGER NOT NULL DEFAULT 0",
      "exec_cache_read_tokens INTEGER NOT NULL DEFAULT 0",
      "exec_cache_write_tokens INTEGER NOT NULL DEFAULT 0",
      "exec_cost_usd REAL NOT NULL DEFAULT 0",
    ]) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* 已存在 */ }
    }
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
    const r = this.db.prepare("SELECT pool_id,platform,external_id,kind,title,archived FROM pools WHERE pool_id=?").get(poolId);
    return r ? rowToPool(r) : undefined;
  }
  /** 短别名 p<rowid>，给 LLM 用以节省 token */
  poolAlias(poolId: string): string {
    const r = this.db.prepare("SELECT rowid FROM pools WHERE pool_id=?").get(poolId) as any;
    return r ? `p${r.rowid}` : poolId;
  }
  /** 接受别名（p3）或完整 pool_id */
  resolvePool(ref: string): Pool | undefined {
    const m = /^p(\d+)$/.exec(ref.trim());
    if (m) {
      const r = this.db.prepare("SELECT pool_id,platform,external_id,kind,title,archived FROM pools WHERE rowid=?").get(Number(m[1]));
      return r ? rowToPool(r) : undefined;
    }
    return this.getPool(ref.trim());
  }
  /** 默认只列没归档的；includeArchived=true 时连归档池一起给（查历史、恢复用）。 */
  listPools(opts: { includeArchived?: boolean } = {}): (Pool & { last_msg_at: number })[] {
    const where = opts.includeArchived ? "" : " WHERE archived=0";
    return (this.db.prepare(`SELECT pool_id,platform,external_id,kind,title,archived,last_msg_at FROM pools${where} ORDER BY last_msg_at DESC`).all() as any[])
      .map((r) => rowToPool(r) as Pool & { last_msg_at: number });
  }
  /** 归档/解档。接受 pool_id 或别名（p3）。返回是否找到。 */
  archivePool(ref: string, archived = true): boolean {
    const pool = this.resolvePool(ref);
    if (!pool) return false;
    this.db.prepare("UPDATE pools SET archived=? WHERE pool_id=?").run(archived ? 1 : 0, pool.pool_id);
    return true;
  }

  // ---------- 身份映射 ----------
  resolveUser(platform: string, platformUserId: string, displayName = ""): string {
    const row = this.db.prepare("SELECT user_id FROM identities WHERE platform=? AND platform_user_id=?").get(platform, platformUserId) as any;
    if (row) {
      if (displayName) {
        const tx = this.db.transaction(() => {
          this.db.prepare("UPDATE identities SET display_name=? WHERE platform=? AND platform_user_id=?").run(displayName, platform, platformUserId);
          this.db.prepare("UPDATE users SET display_name=? WHERE user_id=?").run(displayName, row.user_id);
        });
        tx();
      }
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
  /** 只读解析显示名：人工别名 > 最近一次自动名 > 平台身份名 > 空串。 */
  userDisplayName(platform: string, platformUserId: string): string {
    if (!platform || !platformUserId) return "";
    const row = this.db.prepare(`SELECT u.alias AS user_alias, u.display_name AS user_name, i.display_name AS identity_name
      FROM identities i LEFT JOIN users u ON u.user_id=i.user_id
      WHERE i.platform=? AND i.platform_user_id=?`).get(platform, platformUserId) as any;
    if (!row) return "";
    return String(row.user_alias ?? "").trim() || String(row.user_name ?? "").trim() || String(row.identity_name ?? "").trim();
  }
  /** 用户 + 其绑定身份，给 API / 看板用。 */
  listUsers(): { user_id: string; display_name: string; alias: string; created_at: number; identities: { platform: string; platform_user_id: string; display_name: string }[] }[] {
    const users = this.db.prepare("SELECT user_id,display_name,alias,created_at FROM users ORDER BY created_at, user_id").all() as any[];
    const idents = this.db.prepare("SELECT platform,platform_user_id,user_id,display_name FROM identities ORDER BY platform,platform_user_id").all() as any[];
    const byUser = new Map<string, { platform: string; platform_user_id: string; display_name: string }[]>();
    for (const i of idents) {
      const list = byUser.get(i.user_id) ?? [];
      list.push({ platform: i.platform, platform_user_id: i.platform_user_id, display_name: i.display_name });
      byUser.set(i.user_id, list);
    }
    return users.map((u) => ({
      user_id: u.user_id, display_name: u.display_name, alias: u.alias, created_at: u.created_at,
      identities: byUser.get(u.user_id) ?? [],
    }));
  }
  /** 手动设别名：写 alias（自动名以后还能继续更新）；backfill 时连历史消息的 sender_name 一起改。 */
  renameUser(userId: string, displayName: string, opts: { backfill?: boolean } = {}):
    { user_id: string; display_name: string; alias: string; identities: { platform: string; platform_user_id: string; display_name: string }[]; backfilled: number } | null {
    const name = String(displayName ?? "").trim();
    if (!userId || !name) return null;
    if (!this.db.prepare("SELECT 1 FROM users WHERE user_id=?").get(userId)) return null;
    let backfilled = 0;
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE users SET alias=?, display_name=? WHERE user_id=?").run(name, name, userId);
      this.db.prepare("UPDATE identities SET display_name=? WHERE user_id=?").run(name, userId);
      if (opts.backfill) {
        backfilled = Number(this.db.prepare("UPDATE messages SET sender_name=? WHERE user_id=?").run(name, userId).changes);
      }
    });
    tx();
    const identities = this.db.prepare(
      "SELECT platform,platform_user_id,display_name FROM identities WHERE user_id=? ORDER BY platform,platform_user_id",
    ).all(userId) as any[];
    return { user_id: userId, display_name: name, alias: name, identities, backfilled };
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
    // 归档池来新消息就自动解档：归档只是「暂时不看」，不能变成静音
    this.db.prepare("UPDATE pools SET last_msg_at=MAX(last_msg_at,?), archived=0 WHERE pool_id=?").run(m.ts, pool.pool_id);
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
  /**
   * 关键词搜历史。who 用来挑半边：查「他到底说没说」的时候只看他说的，
   * 因为按最新 N 条截断时，自己反复催问的话会把他的回答挤出去（这就是「翻了确实没有」的来源）。
   */
  searchMessages(poolId: string, keyword: string, limit = 20, who?: "self" | "other"): StoredMessage[] {
    const kw = `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const side = who === "self" ? " AND from_self=1" : who === "other" ? " AND from_self=0" : "";
    const sql = `SELECT * FROM messages WHERE pool_id=? AND text LIKE ? ESCAPE '\\'${side} ORDER BY seq DESC LIMIT ?`;
    return (this.db.prepare(sql).all(poolId, kw, limit) as any[]).map(rowToMsg).reverse();
  }

  /**
   * 取一段 seq 区间的前后消息，用来把记忆回溯到对话现场。
   * 入参是「来源消息区间」；前后各多给 before/after 条，返回按 seq 正序。
   * 仍然按 pool_id 过滤——seq 是全局自增，区间里会夹着别的池的消息。
   */
  messagesAround(poolId: string, startSeq: number, endSeq: number, before = 5, after = 5): StoredMessage[] {
    const lo = Math.max(0, startSeq - Math.max(0, before));
    const hi = endSeq + Math.max(0, after);
    return (this.db.prepare(
      "SELECT * FROM messages WHERE pool_id=? AND seq>=? AND seq<=? AND internal=0 ORDER BY seq",
    ).all(poolId, lo, hi) as any[]).map(rowToMsg);
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
    // internal 是系统留痕（额度提示、长任务提醒等），不该被当成未读交给模型
    return this.messagesAfter(poolId, this.getCursor(poolId), limit).filter((m) => !m.from_self && !m.internal);
  }
  poolsWithUnread(): string[] {
    return (this.db.prepare(`SELECT p.pool_id FROM pools p WHERE p.archived=0 AND EXISTS (SELECT 1 FROM messages m WHERE m.pool_id=p.pool_id AND m.from_self=0
      AND m.internal=0
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
   * 这段沉默里她「醒过来了又决定不说」连了几次。
   *
   * 用途：她连着憋几次就别再惯着——提示词里点一句「这轮必须说」。
   * 旧实现数的是 tide_events 的 wave 档，那套已经删了，所以改数 proactive_log 的 agent_silent。
   * 遇到第一条真正说出口的就断，因为「憋」只对连续的沉默有意义。
   */
  silentStreak(poolId: string, limit = 5): number {
    const rows = this.db.prepare(
      "SELECT decision, reason FROM proactive_log WHERE pool_id=? ORDER BY ts DESC LIMIT ?").all(poolId, limit) as any[];
    let n = 0;
    for (const r of rows) {
      if (r.decision === "skip" && String(r.reason).startsWith("agent_silent")) n++;
      else break;
    }
    return n;
  }

  /** 池里她说的最后一条。主动判定拿它当基准：她一答完时钟就重新起步，
   *  用「任何人最后说话」的话，热聊时永远差几分钟，聊得越热主动机制越死 */
  lastSelfMessage(poolId: string | null): { ts: number; text: string } | null {
    if (poolId === null) return null;
    const row = this.db.prepare(
      "SELECT ts, text FROM messages WHERE pool_id=? AND from_self=1 ORDER BY ts DESC LIMIT 1").get(poolId);
    return (row as any) ?? null;
  }

  /** 池里最后一条消息（时间和是不是她说的），充能判定要用「最后谁说的话」 */
  lastMessage(poolId: string | null): { ts: number; from_self: number } | null {
    const row = poolId === null
      ? this.db.prepare("SELECT ts, from_self FROM messages ORDER BY ts DESC LIMIT 1").get()
      : this.db.prepare("SELECT ts, from_self FROM messages WHERE pool_id=? ORDER BY ts DESC LIMIT 1").get(poolId);
    return (row as any) ?? null;
  }

  // ---------- 自省 / 主动门控 ----------

  saveReflection(r: {
    user_id: string; pool_id: string; thought: string; style_hint: string;
    urgency: number; topic_pick: string; topic_angle: string; next_at: number | null; created_at: number;
  }): number {
    const info = this.db.prepare(
      `INSERT INTO reflections(user_id,pool_id,thought,style_hint,urgency,topic_pick,topic_angle,next_at,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(r.user_id, r.pool_id, r.thought, r.style_hint, r.urgency, r.topic_pick, r.topic_angle, r.next_at ?? null, r.created_at);
    return Number(info.lastInsertRowid);
  }

  /** 这个池最新的一条自省。没有就 null */
  latestReflection(poolId: string): any | null {
    const row = this.db.prepare(
      "SELECT * FROM reflections WHERE pool_id=? ORDER BY created_at DESC LIMIT 1").get(poolId);
    return (row as any) ?? null;
  }

  /** 清掉过期自省，别让它一直长。返回删了几条 */
  pruneReflections(beforeTs: number): number {
    return Number(this.db.prepare("DELETE FROM reflections WHERE created_at < ?").run(beforeTs).changes);
  }

  /** 最后一条用户消息的时间戳；poolId=null 时跨池取最大。0 = 从没说过话 */
  lastUserMessageTs(poolId?: string | null): number {
    const row = poolId
      ? this.db.prepare("SELECT MAX(ts) AS t FROM messages WHERE pool_id=? AND from_self=0").get(poolId)
      // 跨池时排除任务池：任务进度不是「他说话了」，否则任务跑着全局静默永远不增长
      : this.db.prepare(`SELECT MAX(m.ts) AS t FROM messages m JOIN pools p ON p.pool_id=m.pool_id
          WHERE m.from_self=0 AND p.kind!='task' AND p.archived=0`).get();
    return Number((row as any)?.t ?? 0) || 0;
  }

  /**
   * 给自省看的最近一段消息：只取 user/self 的正文，按时间正序。
   * 只给最近 N 条——自省是判断「现在该不该开口」，不是复盘，给太多她会写读后感。
   */
  /**
   * 自省看到的最近对话。
   *
   * 只给「最近 10 条」会出大问题：话密的晚上 10 条可能只覆盖二十分钟，
   * 真正的事实（他早就答过的那句）落在十条之外，而她自己刚说的错误结论正好在里面，
   * 于是念头越滚越像真的（2026-11-03 钥匙那回就是这样）。
   * 所以按「时间跨度 + 条数」双下限取：至少覆盖 recentMs，至少 limit 条，总量封顶 cap。
   */
  messagesForReflection(
    poolId: string, limit = 10, opts: { sinceMs?: number; cap?: number } = {},
  ): { seq: number; ts: number; from_self: number; text: string }[] {
    const cap = Math.max(opts.cap ?? 40, limit);
    const cols = "seq, ts, from_self, text";
    let rows = opts.sinceMs
      ? this.db.prepare(`SELECT ${cols} FROM messages WHERE pool_id=? AND ts>=? ORDER BY ts DESC LIMIT ?`)
        .all(poolId, opts.sinceMs, cap) as any[]
      : [];
    if (rows.length < limit) {
      const have = new Set(rows.map((r) => r.seq));
      const more = this.db.prepare(`SELECT ${cols} FROM messages WHERE pool_id=? ORDER BY ts DESC LIMIT ?`)
        .all(poolId, cap) as any[];
      for (const r of more) {
        if (rows.length >= cap) break;
        if (have.has(r.seq)) continue;
        have.add(r.seq);
        rows.push(r);
      }
    }
    rows.sort((a, b) => a.ts - b.ts);
    return rows.map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), from_self: r.from_self, text: String(r.text ?? "") }));
  }

  logProactive(e: {
    user_id: string; pool_id: string; ts: number; decision: "speak" | "skip"; reason: string;
    urgency?: number | null; silent_sec?: number | null; cooldown_req?: number | null; msg_id?: number | null;
  }): void {
    this.db.prepare(
      `INSERT INTO proactive_log(user_id,pool_id,ts,decision,reason,urgency,silent_sec,cooldown_req,msg_id)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(e.user_id, e.pool_id, e.ts, e.decision, e.reason,
      e.urgency ?? null, e.silent_sec ?? null, e.cooldown_req ?? null, e.msg_id ?? null);
  }

  /** 时间窗内主动开口了几次（decision='speak'） */
  countProactiveSpeaks(fromTs: number, toTs: number, poolId?: string | null): number {
    const row = poolId
      ? this.db.prepare("SELECT COUNT(*) AS n FROM proactive_log WHERE decision='speak' AND pool_id=? AND ts>=? AND ts<?").get(poolId, fromTs, toTs)
      : this.db.prepare("SELECT COUNT(*) AS n FROM proactive_log WHERE decision='speak' AND ts>=? AND ts<?").get(fromTs, toTs);
    return Number((row as any)?.n ?? 0);
  }

  /** 上次主动开口的时间戳（0 = 从没主动说过） */
  lastProactiveSpeakTs(poolId: string): number {
    const row = this.db.prepare(
      "SELECT MAX(ts) AS t FROM proactive_log WHERE decision='speak' AND pool_id=?").get(poolId);
    return Number((row as any)?.t ?? 0) || 0;
  }

  /**
   * 上一次「真的被唤醒过一次」的时刻：发出去算，醒来了决定不说也算。
   *
   * 冷却要挂在这个上，不能挂在「上一次真发」上——她忍住不说的那些轮次以前不留痕迹，
   * 于是每 tick 门全开、同一个念头被反复唤醒（线上实测一个念头连醒 19 次，只发出 2 条）。
   *
   * 只认 agent_silent 开头的 skip：被门拦下也记 skip，那是「没被唤醒」，不能当尝试，
   * 否则冷却会被自己的拦截不断刷新，她就再也开不了口。
   */
  lastProactiveAttemptTs(poolId: string): number {
    const row = this.db.prepare(
      `SELECT MAX(ts) AS t FROM proactive_log
       WHERE pool_id=? AND (decision='speak' OR reason LIKE 'agent_silent%')`).get(poolId);
    return Number((row as any)?.t ?? 0) || 0;
  }

  /** 最近 N 条主动决策，调试用：查「她为什么今天没说话」 */
  recentProactive(limit = 40): any[] {
    return this.db.prepare("SELECT * FROM proactive_log ORDER BY ts DESC LIMIT ?").all(limit) as any[];
  }

  /** 这个池最近一条主动决策（skip 记账节流用） */
  lastProactiveLog(poolId: string): { ts: number; reason: string } | null {
    const row = this.db.prepare(
      "SELECT ts, reason FROM proactive_log WHERE pool_id=? ORDER BY ts DESC LIMIT 1").get(poolId);
    return (row as any) ?? null;
  }

  /** 这个池最近说话的真人是谁（主动日志要记 user_id，没有就空串） */
  lastUserId(poolId: string): string {
    const row = this.db.prepare(
      "SELECT user_id FROM messages WHERE pool_id=? AND user_id IS NOT NULL ORDER BY ts DESC LIMIT 1").get(poolId);
    return String((row as any)?.user_id ?? "");
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

  // ---------- 日程（2026-11-11，取代旧 plans 表） ----------
  insertSchedule(s: {
    title: string; content: string; kind: ScheduleKind;
    cron: string | null; delay_minutes: number | null; next_at: number;
    status?: ScheduleStatus; now: number;
  }): Schedule {
    const r = this.db.prepare(
      `INSERT INTO schedules(title,content,pool_id,kind,cron,delay_minutes,next_at,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      s.title, s.content, null, s.kind, s.cron, s.delay_minutes, s.next_at,
      s.status ?? "active", s.now, s.now,
    );
    return this.getSchedule(Number(r.lastInsertRowid))!;
  }

  getSchedule(id: number): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id);
    return r ? rowToSchedule(r) : undefined;
  }

  listSchedules(status?: ScheduleStatus): Schedule[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM schedules WHERE status=? ORDER BY next_at ASC, id ASC").all(status)
      : this.db.prepare("SELECT * FROM schedules ORDER BY status='active' DESC, next_at ASC, id ASC").all();
    return rows.map(rowToSchedule);
  }

  /** 到点且仍 active 的日程，按时间先后；同一轮只取最先到点的几条 */
  dueSchedules(now: number, limit = 20): Schedule[] {
    return this.db.prepare(
      "SELECT * FROM schedules WHERE status='active' AND next_at<=? ORDER BY next_at ASC, id ASC LIMIT ?",
    ).all(now, limit).map(rowToSchedule);
  }

  /** 取消/恢复；只改状态，不删行 */
  setScheduleStatus(id: number, status: ScheduleStatus, now: number): Schedule | undefined {
    this.db.prepare("UPDATE schedules SET status=?, updated_at=? WHERE id=?").run(status, now, id);
    return this.getSchedule(id);
  }

  /**
   * 触发后推进：只有 next_at 仍是触发时的值才更新，避免重复唤醒把下一档覆盖掉。
   * nextAt=null 表示一次性日程，status 落 done。
   */
  advanceSchedule(id: number, fromNextAt: number, nextAt: number | null, firedAt: number, status: ScheduleStatus): boolean {
    return this.db.prepare(
      "UPDATE schedules SET next_at=?, status=?, last_fired_at=?, updated_at=? WHERE id=? AND next_at=? AND status='active'",
    ).run(nextAt ?? fromNextAt, status, firedAt, firedAt, id, fromNextAt).changes > 0;
  }

  // ---------- 谈资（话题库） ----------
  // 和 memories 分开存：记忆是「对方说过的具体事实」，谈资是「可以拿来聊的东西」。
  // 混一张表的后果是谈资把记忆的检索结果挤掉，真正该记住的事被埋。
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

  // ---------- 知识库 ----------
  addKnowledge(k: {
    title: string; body: string; tags?: string; object_id?: string;
    source_pool_id?: string; source_seq_start?: number | null; source_seq_end?: number | null; now: number;
  }): number {
    const r = this.db.prepare(
      `INSERT INTO knowledge(title,body,tags,object_id,source_pool_id,source_seq_start,source_seq_end,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      k.title, k.body, k.tags ?? "[]", k.object_id ?? "", k.source_pool_id ?? "",
      k.source_seq_start ?? null, k.source_seq_end ?? null, k.now, k.now,
    );
    return Number(r.lastInsertRowid);
  }

  getKnowledge(id: number): any | null {
    return (this.db.prepare("SELECT * FROM knowledge WHERE id=?").get(id) as any) ?? null;
  }

  searchKnowledge(o: { q?: string; tag?: string; limit?: number; includeRetired?: boolean } = {}): any[] {
    const where = [o.includeRetired ? "1=1" : "retired=0"];
    const args: any[] = [];
    if (o.q?.trim()) {
      const like = `%${o.q.trim()}%`;
      where.push("(title LIKE ? OR body LIKE ? OR tags LIKE ?)");
      args.push(like, like, like);
    }
    if (o.tag?.trim()) {
      where.push("tags LIKE ?");
      args.push(`%"${o.tag.trim()}"%`);
    }
    args.push(o.limit ?? 20);
    return this.db.prepare(
      `SELECT * FROM knowledge WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...args) as any[];
  }

  updateKnowledge(id: number, patch: { title?: string; body?: string; tags?: string; object_id?: string; now: number }): any | null {
    const sets: string[] = ["updated_at=?"];
    const args: any[] = [patch.now];
    for (const key of ["title", "body", "tags", "object_id"] as const) {
      if (patch[key] !== undefined) { sets.push(`${key}=?`); args.push(patch[key]); }
    }
    args.push(id);
    this.db.prepare(`UPDATE knowledge SET ${sets.join(",")} WHERE id=?`).run(...args);
    return this.getKnowledge(id);
  }

  retireKnowledge(id: number, now: number): boolean {
    return this.db.prepare("UPDATE knowledge SET retired=1, updated_at=? WHERE id=?").run(now, id).changes > 0;
  }

  // ---------- 记忆 ----------
  /**
   * 写一条记忆。supersede 传旧条目 id 时，新条目插入后立刻把旧的标成失效。
   *
   * 顺序是有意的：先插新的拿到 id，再回头顶旧的——不然中途失败会留下「旧的已经失效、
   * 新的却没写进去」的空洞，那比两条并存更糟。
   */
  addMemory(m: {
    user_id: string; kind?: string; content: string; source_pool_id: string; source_kind: PoolKind; scope: MemoryScope;
    valid_from?: number | null; valid_to?: number | null; supersede?: number | null;
    source_seq_start?: number | null; source_seq_end?: number | null;
  }): number {
    const now = Date.now();
    const id = Number(this.db.prepare(
      "INSERT INTO memories(user_id,kind,content,source_pool_id,source_kind,scope,created_at,valid_from,valid_to,source_seq_start,source_seq_end) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(m.user_id, m.kind ?? "fact", m.content, m.source_pool_id, m.source_kind, m.scope, now,
        m.valid_from ?? null, m.valid_to ?? null, m.source_seq_start ?? null, m.source_seq_end ?? null).lastInsertRowid);
    if (m.supersede) this.supersedeMemory(m.supersede, id, m.valid_from ?? now);
    return id;
  }

  getMemory(id: number): any | null {
    return (this.db.prepare("SELECT * FROM memories WHERE id=?").get(id) as any) ?? null;
  }

  /** 就地改一条记忆的正文（订正错字、补细节）。不碰有效期——改「什么时候的事」走 valid_from */
  updateMemoryRow(id: number, patch: { content?: string; valid_from?: number | null; valid_to?: number | null }): boolean {
    const sets: string[] = [];
    const args: any[] = [];
    if (patch.content !== undefined) { sets.push("content=?"); args.push(patch.content); }
    if (patch.valid_from !== undefined) { sets.push("valid_from=?"); args.push(patch.valid_from); }
    if (patch.valid_to !== undefined) { sets.push("valid_to=?"); args.push(patch.valid_to); }
    if (!sets.length) return false;
    args.push(id);
    const r = this.db.prepare(`UPDATE memories SET ${sets.join(",")} WHERE id=?`).run(...args);
    return Number(r.changes) > 0;
  }

  /** 只关闭一条记忆（没有新事实顶替）：valid_to 设上，superseded_by 保持空 */
  closeMemoryRow(id: number, at = Date.now()): boolean {
    const r = this.db.prepare("UPDATE memories SET valid_to = COALESCE(valid_to, ?) WHERE id=?").run(at, id);
    return Number(r.changes) > 0;
  }

  /** 硬删除一条记忆（Web 管理台用）；日常过期请走 closeMemoryRow。 */
  deleteMemoryRow(id: number): boolean {
    const r = this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
    return Number(r.changes) > 0;
  }

  /**
   * 把一条记忆标成「到此为止」。
   * COALESCE 保证已经失效的不被后来的时间覆盖——失效时刻只有第一次算数。
   */
  supersedeMemory(oldId: number, newId: number, at = Date.now()): boolean {
    const r = this.db.prepare(
      "UPDATE memories SET valid_to = COALESCE(valid_to, ?), superseded_by = COALESCE(superseded_by, ?) WHERE id = ?",
    ).run(at, newId, oldId);
    return Number(r.changes) > 0;
  }
  /**
   * 在 viewingPool 里能看到的某用户记忆（可见范围过滤 + 时间过滤）。
   *
   * 默认只给「此刻有效」的：她要知道的是现在，不是历史快照。
   *   at  给了就查「那一刻有效」的（人问「我以前说过什么」时才用）
   *   includeExpired 连失效的一起给（调试 / 她自己想理时间线）
   */
  visibleMemories(
    userId: string, viewingPool: Pool, limit: number,
    opts: { at?: number; includeExpired?: boolean; q?: string } = {},
  ): any[] {
    const base = `SELECT id,kind,content,source_pool_id,scope,created_at,valid_from,valid_to,superseded_by,source_seq_start,source_seq_end
      FROM memories WHERE user_id=? AND (
        scope='all' OR (scope='pool' AND source_pool_id=?) OR (scope='private' AND ?='private') OR (scope='group' AND ?='group')
      )`;
    const args: any[] = [userId, viewingPool.pool_id, viewingPool.kind, viewingPool.kind];
    let valid = "";
    if (opts.at !== undefined) {
      valid = " AND COALESCE(valid_from, created_at) <= ? AND (valid_to IS NULL OR valid_to > ?)";
      args.push(opts.at, opts.at);
    } else if (!opts.includeExpired) {
      valid = " AND valid_to IS NULL";
    }
    if (opts.q) {
      valid += " AND content LIKE ? ESCAPE '\\'";
      args.push(`%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    args.push(limit);
    return this.db.prepare(`${base}${valid} ORDER BY id DESC LIMIT ?`).all(...args) as any[];
  }

  /**
   * 全局翻记忆：不按池的可见范围过滤，给管理台列全部人、全部池记下的条目。
   * 新的在前（created_at DESC，同一毫秒再按 id 兜底），offset 分页。
   */
  queryMemories(opts: {
    userId?: string; kind?: string; scope?: string; status?: "valid" | "expired"; q?: string;
    limit: number; offset: number;
  }): { rows: any[]; total: number } {
    const where: string[] = [];
    const args: any[] = [];
    if (opts.userId) { where.push("user_id=?"); args.push(opts.userId); }
    if (opts.kind) { where.push("kind=?"); args.push(opts.kind); }
    if (opts.scope) { where.push("scope=?"); args.push(opts.scope); }
    if (opts.status === "valid") where.push("valid_to IS NULL");
    else if (opts.status === "expired") where.push("valid_to IS NOT NULL");
    if (opts.q) {
      where.push("content LIKE ? ESCAPE '\\'");
      args.push(`%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS n FROM memories${clause}`).get(...args) as any)?.n ?? 0,
    );
    const rows = this.db.prepare(
      `SELECT id,user_id,kind,content,source_pool_id,source_kind,scope,created_at,valid_from,valid_to,superseded_by,source_seq_start,source_seq_end
       FROM memories${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...args, opts.limit, opts.offset) as any[];
    return { rows, total };
  }

  // ---------- 业务地图 ----------
  // 结构化查询直接读这几张表；写入走 replaceBusinessMap 全量替换（事务内），
  // 不让半份地图留在库里。
  businessMetaAll(): Record<string, string> {
    const rows = this.db.prepare("SELECT k,v FROM business_meta").all() as any[];
    return Object.fromEntries(rows.map((r) => [String(r.k), String(r.v)]));
  }
  setBusinessMeta(k: string, v: string) {
    this.db.prepare("INSERT INTO business_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);
  }
  listBusinessTypes(): any[] {
    return this.db.prepare("SELECT id,name,description FROM business_types ORDER BY id").all() as any[];
  }
  listBusinessObjects(): any[] {
    return this.db.prepare("SELECT id,type,name,description,key_kind,key_value,source_kind,source_value,aliases,tags,graph_id,import_batch FROM business_objects ORDER BY id").all() as any[];
  }
  listBusinessRelations(): any[] {
    return this.db.prepare("SELECT id,name,from_type,to_type,cardinality,direction,risk,semantics,graph_id,import_batch FROM business_relations ORDER BY id").all() as any[];
  }
  listBusinessEdges(): any[] {
    return this.db.prepare("SELECT relation_id,from_id,to_id,evidence,updated_at,graph_id,import_batch FROM business_edges ORDER BY relation_id,from_id,to_id").all() as any[];
  }
  listBusinessActions(): any[] {
    return this.db.prepare("SELECT id,name,applies_to,risk,requires_relations,description FROM business_actions ORDER BY id").all() as any[];
  }
  listBusinessTerms(): any[] {
    return this.db.prepare("SELECT term,object_id,note FROM business_terms ORDER BY term").all() as any[];
  }
  /** 全量替换业务地图：先清后写，失败整体回滚。 */
  replaceBusinessMap(data: {
    version: number;
    types: { id: string; name?: string; description?: string }[];
    objects: { id: string; type: string; name?: string; description?: string; key?: { kind?: string; value: string } | null; source?: { kind?: string; value: string } | null; aliases?: string[]; tags?: string[]; graph_id?: string; import_batch?: string }[];
    relations: { id: string; name?: string; fromType: string; toType: string; cardinality?: string; direction?: string; risk?: string; semantics?: string; graph_id?: string; import_batch?: string }[];
    edges: { relation: string; from: string; to: string; evidence?: string | null; graph_id?: string; import_batch?: string }[];
    actions: { id: string; name?: string; appliesTo?: string[]; risk?: string; requiresRelations?: string[]; description?: string }[];
    terms: { term: string; objectId: string; note?: string }[];
  }): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const t of ["business_edges", "business_terms", "business_actions", "business_relations", "business_objects", "business_types", "business_meta"]) {
        this.db.prepare(`DELETE FROM ${t}`).run();
      }
      const typeStmt = this.db.prepare("INSERT INTO business_types(id,name,description) VALUES(?,?,?)");
      for (const t of data.types) typeStmt.run(t.id, t.name ?? "", t.description ?? "");
      const objStmt = this.db.prepare(`INSERT INTO business_objects(id,type,name,description,key_kind,key_value,source_kind,source_value,aliases,tags,graph_id,import_batch)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const o of data.objects) {
        objStmt.run(o.id, o.type, o.name ?? "", o.description ?? "", o.key?.kind ?? null, o.key?.value ?? null,
          o.source?.kind ?? null, o.source?.value ?? null, JSON.stringify(o.aliases ?? []), JSON.stringify(o.tags ?? []),
          o.graph_id ?? "default", o.import_batch ?? "");
      }
      const relStmt = this.db.prepare(`INSERT INTO business_relations(id,name,from_type,to_type,cardinality,direction,risk,semantics,graph_id,import_batch)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const r of data.relations) {
        relStmt.run(r.id, r.name ?? "", r.fromType, r.toType, r.cardinality ?? null, r.direction ?? null, r.risk ?? null, r.semantics ?? null,
          r.graph_id ?? "default", r.import_batch ?? "");
      }
      const edgeStmt = this.db.prepare("INSERT INTO business_edges(relation_id,from_id,to_id,evidence,updated_at,graph_id,import_batch) VALUES(?,?,?,?,?,?,?)");
      for (const e of data.edges) edgeStmt.run(e.relation, e.from, e.to, e.evidence ?? null, now, e.graph_id ?? "default", e.import_batch ?? "");
      const actStmt = this.db.prepare(`INSERT INTO business_actions(id,name,applies_to,risk,requires_relations,description)
        VALUES(?,?,?,?,?,?)`);
      for (const a of data.actions) {
        actStmt.run(a.id, a.name ?? "", JSON.stringify(a.appliesTo ?? []), a.risk ?? null,
          JSON.stringify(a.requiresRelations ?? []), a.description ?? "");
      }
      const termStmt = this.db.prepare("INSERT INTO business_terms(term,object_id,note) VALUES(?,?,?)");
      for (const t of data.terms) termStmt.run(t.term, t.objectId, t.note ?? "");
      this.setBusinessMeta("version", String(data.version));
      this.setBusinessMeta("updated_at", String(now));
    });
    tx();
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
  getUsage(day: string): {
    llm_calls: number; tokens: number; wakes: number;
    cache_hit: number; cache_miss: number; out_tokens: number; cost_usd: number;
  } {
    return (this.db.prepare("SELECT llm_calls,tokens,wakes,cache_hit,cache_miss,out_tokens,cost_usd FROM usage_daily WHERE day=?").get(day) as any)
      ?? { llm_calls: 0, tokens: 0, wakes: 0, cache_hit: 0, cache_miss: 0, out_tokens: 0, cost_usd: 0 };
  }
  addUsage(
    day: string, calls: number, tokens: number, wakes = 0,
    extra: { cacheHit?: number; cacheMiss?: number; outTokens?: number; costUsd?: number } = {},
  ) {
    const hit = Math.round(extra.cacheHit ?? 0), miss = Math.round(extra.cacheMiss ?? 0);
    const outTok = Math.round(extra.outTokens ?? 0), usd = Number(extra.costUsd ?? 0) || 0;
    this.db.prepare(`INSERT INTO usage_daily(day,llm_calls,tokens,wakes,cache_hit,cache_miss,out_tokens,cost_usd) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET
      llm_calls=llm_calls+excluded.llm_calls, tokens=tokens+excluded.tokens, wakes=wakes+excluded.wakes,
      cache_hit=cache_hit+excluded.cache_hit, cache_miss=cache_miss+excluded.cache_miss,
      out_tokens=out_tokens+excluded.out_tokens, cost_usd=cost_usd+excluded.cost_usd`).run(day, calls, tokens, wakes, hit, miss, outTok, usd);
  }

  // ---------- 逐次用量事件（2026-11-10）：按次记账，按小时/天在 Web 里聚合 ----------
  addUsageEvent(e: {
    ts: number; source?: string; model?: string; cacheHit: number; cacheMiss: number;
    outTokens: number; totalTokens: number; costUsd: number; calls?: number;
  }): number {
    const r = this.db.prepare(
      `INSERT INTO usage_events(ts,source,model,cache_hit,cache_miss,calls,out_tokens,total_tokens,cost_usd)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      Math.round(e.ts), e.source ?? "llm", e.model ?? "",
      Math.round(e.cacheHit), Math.round(e.cacheMiss), Math.round(e.calls ?? 1),
      Math.round(e.outTokens), Math.round(e.totalTokens), Number(e.costUsd) || 0,
    );
    return Number(r.lastInsertRowid);
  }

  listUsageEvents(from: number, to: number, limit?: number): UsageEventRow[] {
    const base = "SELECT id,ts,source,model,cache_hit,cache_miss,calls,out_tokens,total_tokens,cost_usd FROM usage_events WHERE ts>=? AND ts<? ORDER BY ts DESC";
    const rows = limit === undefined
      ? this.db.prepare(base).all(from, to)
      : this.db.prepare(`${base} LIMIT ?`).all(from, to, Math.max(0, Math.round(limit)));
    return (rows as any[]).map((r) => ({
      id: Number(r.id), ts: Number(r.ts), source: String(r.source), model: String(r.model),
      cacheHit: Number(r.cache_hit), cacheMiss: Number(r.cache_miss), calls: Number(r.calls),
      outTokens: Number(r.out_tokens), totalTokens: Number(r.total_tokens), costUsd: Number(r.cost_usd),
    }));
  }

  countUsageEvents(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as any)?.n ?? 0);
  }

  /**
   * 历史唤醒日志回填：只在 usage_events 为空时跑一次。
   * wake_log 的 JSON 是「一轮唤醒的聚合」，所以这些行 source='wake'、model=''，
   * 也只填 total_tokens / cost_usd（当时没记三段和输出）。
   */
  backfillUsageEventsFromWakeLog(): number {
    if (this.countUsageEvents() > 0) {
      // 老回填行 calls 默认是 1：按 wake_log 的 llmCalls 修一次，避免历史摘要偏小
      this.repairBackfilledUsageCalls();
      return 0;
    }
    const rows = this.db.prepare("SELECT ts, json FROM wake_log ORDER BY id").all() as { ts: number; json: string }[];
    const insert = this.db.prepare(
      `INSERT INTO usage_events(ts,source,model,cache_hit,cache_miss,calls,out_tokens,total_tokens,cost_usd)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        let json: any;
        try { json = JSON.parse(row.json); } catch { continue; }
        const totalTokens = Number(json?.rawTokens ?? json?.tokens ?? 0) || 0;
        if (totalTokens <= 0) continue;
        const parsedTs = Number(json?.ts);
        const ts = Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : Number(row.ts);
        const cost = Number(json?.cost ?? 0) || 0;
        const calls = Number(json?.llmCalls ?? 1) || 1;
        insert.run(Math.round(ts), "wake", "", 0, 0, Math.round(calls), 0, Math.round(totalTokens), cost);
        inserted++;
      }
    });
    tx();
    return inserted;
  }

  /**
   * 修正老回填行：usage_events 里 source='wake' 且 calls=1 的行，
   * 按 wake_log 的 llmCalls 重算。JSON.ts 是 ISO 字符串，必须用 Date.parse；
   * 没有 JSON.ts 时才用列 ts。更新数量返回给调用方便于观测。
   */
  repairBackfilledUsageCalls(): number {
    const logs = this.db.prepare("SELECT ts, json FROM wake_log ORDER BY id").all() as { ts: number; json: string }[];
    const byColumnTs = new Map<number, number>();
    const byJsonTs = new Map<number, number>();
    for (const log of logs) {
      let json: any;
      try { json = JSON.parse(log.json); } catch { continue; }
      const calls = Number(json?.llmCalls ?? 1) || 1;
      if (calls <= 1) continue;
      const colTs = Math.round(Number(log.ts));
      if (Number.isFinite(colTs)) byColumnTs.set(colTs, calls);
      const rawJsonTs = json?.ts;
      const parsedJsonTs = typeof rawJsonTs === "string"
        ? Date.parse(rawJsonTs)
        : typeof rawJsonTs === "number" ? rawJsonTs : Number.NaN;
      if (Number.isFinite(parsedJsonTs)) byJsonTs.set(Math.round(parsedJsonTs), calls);
    }

    const rows = this.db.prepare("SELECT id, ts FROM usage_events WHERE source='wake' AND calls=1").all() as { id: number; ts: number }[];
    const update = this.db.prepare("UPDATE usage_events SET calls=? WHERE id=?");
    let repaired = 0;
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const ts = Math.round(Number(row.ts));
        const calls = byJsonTs.get(ts) ?? byColumnTs.get(ts);
        if (calls === undefined || calls <= 1) continue;
        update.run(calls, row.id);
        repaired++;
      }
    });
    tx();
    return repaired;
  }
}

export interface UsageEventRow {
  id: number;
  ts: number;
  source: string;
  model: string;
  cacheHit: number;
  cacheMiss: number;
  calls: number;
  outTokens: number;
  totalTokens: number;
  costUsd: number;
}
