export interface Pool {
  alias: string;
  pool_id: string;
  kind: string;
  title: string;
  archived: boolean;
  last_msg_at: number | null;
  last_msg_local: string | null;
  total: number;
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

export interface BoardGoal {
  text: string;
  done: boolean;
}

export interface BoardProgress {
  at: number | null;
  at_local: string | null;
  text: string;
}

export interface Board {
  slug: string;
  title: string;
  status: string;
  pool: string | null;
  tags: string[];
  background: string;
  goals: BoardGoal[];
  goals_total: number;
  goals_done: number;
  progress: BoardProgress[];
  created_at: number | null;
  created_at_local: string | null;
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

export interface UsageStats {
  bucket: "hour" | "day";
  from: number;
  to: number;
  summary: UsageSummary;
  series: UsagePoint[];
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

export type ScheduleKind = "cron" | "delay";
export type ScheduleStatus = "active" | "cancelled" | "done";

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

export interface RuntimeFile {
  path: string;
  content: string;
  source: "runtime" | "repo" | "config";
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
