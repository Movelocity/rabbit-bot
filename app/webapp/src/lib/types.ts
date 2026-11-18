export interface Pool {
  alias: string;
  pool_id: string;
  platform?: string;
  kind: string;
  title: string;
  archived: boolean;
  /** 主聊天（main chat）：任务汇报只发这里，审批消息也发到这里 */
  is_main: boolean;
  last_msg_at: number | null;
  last_msg_local: string | null;
  total: number;
  /** 游标之后、非自己发、非系统留痕的消息数 */
  unread?: number | null;
  /** 调度器已读游标（最后处理到的 seq） */
  cursor?: number | null;
}

export interface LimitSettings {
  /** 每天最多调用几次；-1 = 不设这条闸 */
  dailyLlmCalls: number;
  /** 折算 token 日额度；-1 = 不设这条闸 */
  dailyTokens: number;
  /** 每天最多花多少人民币；0 = 不按钱限额 */
  dailyCny: number;
}

export interface LimitToday {
  day: string;
  llm_calls: number;
  tokens: number;
  cost_usd: number;
  cost_cny: number;
  calls_left: number | null;
  tokens_left: number | null;
  cny_left: number | null;
}

export interface LimitStatus extends LimitSettings {
  usdCny: number;
  today: LimitToday;
}

export interface ContextLimitSettings {
  /** 上下文涨到多少 token 就触发交接（另起新会话） */
  tokenLimit: number;
}

export interface PoolMessage {
  seq: number;
  ts: number;
  local: string;
  from_self: boolean;
  sender: string;
  sender_name: string;
  sender_id: string;
  user_id: string;
  text: string;
}

export interface PoolMessages {
  pool: string;
  total: number;
  oldest_seq: number | null;
  messages: PoolMessage[];
}

export type TaskStatus =
  | "pending_approval"
  | "pending"
  | "running"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface TaskContext {
  objects?: string[];
  relations?: string[];
  forbidden?: string[];
}

export interface TaskView {
  id: number;
  name: string;
  goal: string;
  pool_id: string;
  task_pool_id: string;
  status: TaskStatus;
  stage: string;
  worker_id: string | null;
  note: string;
  deliverable: string;
  constraints: string;
  acceptance: string;
  files: string;
  context: TaskContext;
  result: string;
  artifact: string;
  work_dir: string;
  executor: string;
  model: string;
  session_id: string;
  runner_pid: number | null;
  runner_started_at: number | null;
  doc_path: string;
  start_at: number;
  start_at_local: string;
  end_at: number | null;
  end_at_local: string | null;
  updated_at: number;
  updated_at_local: string;
}

export interface TaskEvent {
  seq: number;
  ts: number;
  local: string;
  sender: string;
  text: string;
}

export interface TaskSnapshot {
  task: Partial<TaskView> & { id: number };
  recent_events: TaskEvent[];
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";

export interface Approval {
  id: number;
  task_id: number;
  worker_id: string;
  action: string;
  detail: string;
  why: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
  expires_at: number;
  created_at_local: string;
  expires_at_local: string;
  decided_at_local: string | null;
}

/** shared/projects/<slug>/：context.md 是项目上下文，plan.md 是当前目标与下一步。 */
export interface Project {
  slug: string;
  title: string;
  /** INDEX.md 里的状态原文；没登记就是空串 */
  status: string;
  context: string;
  plan: string;
  updated_at: number | null;
  updated_at_local: string | null;
  path: string;
}

export type MemoryScope = "pool" | "private" | "group" | "all";

export interface Memory {
  id: number;
  kind: string;
  scope: MemoryScope;
  content: string;
  from: number;
  to: number | null;
  replaced_by: number | null;
  user_id?: string;
  source_pool?: string;
  created_at?: number;
  source_seq_start?: number | null;
  source_seq_end?: number | null;
}

export interface MemoryTraceMessage {
  seq: number;
  ts: number;
  local: string;
  from_self: boolean;
  sender: string;
  user_id: string | null;
  text: string;
  anchor: boolean;
}

export interface MemoryTrace {
  id: number;
  user_id: string;
  kind: string;
  content: string;
  source: { pool_id: string; pool: string; from: number; to: number } | null;
  note?: string;
  messages: MemoryTraceMessage[];
}

export interface MemoryList {
  total: number;
  limit: number;
  offset: number;
  rows: Memory[];
}

export interface UserIdentity {
  platform: string;
  platform_user_id: string;
  display_name: string;
}

export interface User {
  user_id: string;
  display_name: string;
  alias: string;
  created_at: number;
  identities: UserIdentity[];
}

export interface UsageSummary {
  calls: number;
  tokens: number;
  cacheHit: number;
  cacheMiss: number;
  outTokens: number;
  costUsd: number;
  hitRate: number;
}

export interface UsagePoint {
  key: string;
  label: string;
  calls: number;
  tokens: number;
  cacheHit: number;
  cacheMiss: number;
  outTokens: number;
  costUsd: number;
}

export interface UsageCall {
  ts: number;
  ts_local: string;
  source: string;
  model: string;
  calls: number;
  cacheHit: number;
  cacheMiss: number;
  outTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageModelRow {
  model: string;
  calls: number;
  cacheHit: number;
  cacheMiss: number;
  outTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageStats {
  bucket: "hour" | "day";
  from: number;
  to: number;
  summary: UsageSummary;
  series: UsagePoint[];
  /** 区间全量按模型汇总；明细列表有 limit，不能拿来当汇总 */
  by_model: UsageModelRow[];
}

export interface TaskStatsSummary {
  tasks: number;
  durationMs: number;
  avgDurationMs: number;
  steps: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface TaskStatsExecutor extends TaskStatsSummary {
  executor: string;
}

export interface TaskStatsRow {
  id: number;
  name: string;
  executor: string;
  model: string;
  end_at: number;
  end_at_local: string;
  duration_ms: number;
  steps: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

export interface TaskStats {
  from: number;
  to: number;
  summary: TaskStatsSummary;
  by_executor: TaskStatsExecutor[];
  tasks: TaskStatsRow[];
}

export interface ExecutorInfo {
  name: string;
  bin: string;
  available: boolean;
  version: string;
  error: string;
}

export interface ExecutorPreference {
  executor: string;
}

export interface Skill {
  name: string;
  description: string;
  skill: string;
  data: string | null;
  has_data: boolean;
  readonly: boolean;
}

export interface SchedulerSettings {
  privateWakeMs: number;
  groupWakeMs: number;
  taskWakeMs: number;
}

export interface SchedulerStatus {
  /** 后端是否注入调度器；否时只有设置、没有运行态 */
  available: boolean;
  /** 服务端当前时间，用它对时，避免浏览器时钟漂移 */
  now: number;
  paused: boolean;
  last_tick_at: number | null;
  next_tick_at: number | null;
  next_task_at: number | null;
  next_schedule_at: number | null;
  debouncing: { pool: string; dueAt: number; count: number }[];
  recovered: number;
  pauses_detected: number;
  tick_ms: number;
  active_tick_ms: number;
  active_window_ms: number;
}

export interface AdapterGap {
  from: number;
  to: number;
  missed: number;
  checked_at: number;
  error?: string;
}

export interface AdapterStatus {
  platform: string;
  state: "connecting" | "connected" | "reconnecting" | "stopped";
  since: number;
  connected_at: number | null;
  disconnected_at: number | null;
  last_error?: string;
  last_gap: AdapterGap | null;
}

export interface AdapterStatusResponse {
  now: number;
  adapters: AdapterStatus[];
}

export type ScheduleKind = "cron" | "delay";export type ScheduleStatus = "active" | "cancelled" | "done";

export interface Schedule {
  id: number;
  title: string;
  content: string;
  kind: ScheduleKind;
  cron: string | null;
  delay_minutes: number | null;
  status: ScheduleStatus;
  next_at: number;
  next_at_local: string;
  last_fired_at: number | null;
  last_fired_at_local: string | null;
  created_at: number;
  created_at_local: string;
}

export interface MemoryReviewSettings {
  enabled: boolean;
  everyTurns: number;
  minIntervalSec: number;
}

export interface WatchdogSettings {
  enabled: boolean;
  delayMs: number;
  cooldownMs: number;
}

export interface SendReviewSettings {
  enabled: boolean;
  defaultReview: boolean;
  /** 主对话池：永远不审核，审批消息也发到这里 */
  primaryPoolId: string | null;
  /** pool_id → 是否审核；true = 需审批，false = 直接发 */
  overrides: Record<string, boolean>;
}

export interface SendReviewSettingsResponse extends SendReviewSettings {
  /** 审批房和主人有没有配好；没配好时不能打开总开关 */
  ready: boolean;
}

export interface RuntimeFile {
  path: string;
  content: string;
  source: "runtime" | "repo" | "config";
}

export interface ModelChoice {
  provider: string;
  model: string;
  label?: string;
}

export interface ModelSettings {
  provider: string;
  model: string;
  choices: ModelChoice[];
}

export interface ModelSettingsResponse extends ModelSettings {
  available: { provider: string; model: string; name: string }[];
  available_error?: string;
}

export interface WorkingMemory {
  path: string;
  content: string;
  chars: number;
  limit: number;
  truncated: boolean;
}

export interface BusinessObjectType {
  id: string;
  name?: string;
  description?: string;
}

export interface BusinessObject {
  id: string;
  type: string;
  name: string;
  aliases?: string[];
  description?: string;
  key?: { kind?: string; value: string };
  source?: { kind?: string; value: string };
  tags?: string[];
  graph_id?: string;
  import_batch?: string;
}

export interface BusinessRelation {
  id: string;
  name: string;
  fromType: string;
  toType: string;
  kind?: string;
  cardinality?: string;
  direction?: string;
  risk?: "low" | "medium" | "high";
  semantics?: string;
  mapping?: { kind?: string; file?: string; select?: string };
  edge_count?: number;
  graph_id?: string;
  import_batch?: string;
}

export interface BusinessAction {
  id: string;
  name?: string;
  appliesTo?: string[];
  risk?: "low" | "medium" | "high";
  requiresRelations?: string[];
  description?: string;
}

export interface BusinessTerm {
  term: string;
  objectId: string;
  note?: string;
}

export interface BusinessEdge {
  relation: string;
  relation_name: string;
  from: string;
  to: string;
  graph_id?: string;
  import_batch?: string;
  evidence?: string | null;
}

export interface BusinessLintFinding {
  level: "error" | "warn" | "info";
  code: string;
  message: string;
  ref?: string;
}

export interface BusinessLintReport {
  checked_at: number;
  exists: boolean;
  version: number | null;
  counts: { types: number; objects: number; relations: number; edges: number; actions: number; terms: number };
  findings: BusinessLintFinding[];
  summary: { error: number; warn: number; info: number };
}

export interface BusinessData {
  exists: boolean;
  dir: string;
  version: number | null;
  types: BusinessObjectType[];
  objects: BusinessObject[];
  relations: BusinessRelation[];
  actions: BusinessAction[];
  terms: BusinessTerm[];
  edges: BusinessEdge[];
  edge_total: number;
  edges_truncated: boolean;
}

export type BusinessCategory = "objects" | "relations" | "actions" | "terms" | "types";

export interface BusinessSelection {
  kind: BusinessCategory;
  id: string;
}

export interface LlmSessionSummary {
  id: string;
  started_at: number | null;
  updated_at: number;
  size: number;
  messages: number;
  model: string;
  provider: string;
  preview: string;
  pools: string[];
}

export interface LlmToolCall {
  id?: string;
  name: string;
  args: string;
  args_truncated?: boolean;
}

export interface LlmUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface LlmLogMessage {
  index: number;
  ts: number | null;
  role: string;
  text: string;
  truncated?: boolean;
  tool_calls?: LlmToolCall[];
  tool_name?: string;
  tool_call_id?: string;
  is_error?: boolean;
  model?: string;
  provider?: string;
  stop_reason?: string;
  duration_ms?: number;
  usage?: LlmUsage;
}

export interface LlmSessionDetail {
  id: string;
  started_at: number | null;
  updated_at: number;
  size: number;
  model: string;
  provider: string;
  pools: string[];
  total: number;
  next_before: number | null;
  messages: LlmLogMessage[];
}

export interface OutputEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  bytes?: number;
  mtime?: number;
}

export interface OutputFile {
  path: string;
  name: string;
  ext: string;
  bytes: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

export interface OutputNode {
  path: string;
  name: string;
  kind: "file" | "dir";
  bytes?: number;
  mtime?: number;
  children?: OutputNode[];
}
