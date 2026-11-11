# 调研：agentdock 的 worker 注册制 → rabbit-bot UFA-WA 接入设计

> 参考仓库：`~/projects/sw-proj/agentdock`（只读，未修改）。配套：`docs/ARCH-UFA-WA.md`（行为约定）、`docs/SPEC-UFA-WA.md`（tasks 表与 API 已定）。
> **2026-02 修订（范围收窄）**：worker 端只做「领任务 + 运行快照」；砍掉能力矩阵、版本/并发声明、详细上下线、逐条工具事件上报；权限申请必须持久化并上呈用户；任务完成给 UFA 一个**可合并的 pending tick**；Web 是纯只读看板，审批动作只走 UFA/飞书。行号以调研当日为准。

---

## 0. 结论先行

只做四件事，每件的细节见 §2：

| # | 设计 | 一句话 |
|---|---|---|
| 1 | 任务派发 | pull claim：worker 2s 循环原子领取 `tasks` 表里 `pending` 的任务 |
| 2 | 运行快照 | `tasks` 上的 `status/stage/note/artifact` 四个字段 + 单行 UPDATE 上报，**无事件表、无工具明细** |
| 3 | 权限申请 | 新表 `approvals` 持久化 → 看板/API 只读可见 → UFA/飞书裁决 → worker 轮询取结果 |
| 4 | pending tick | `kv` 表一行标记：「无标记→有标记」才唤醒 UFA，一次消费多条更新 |

**不引入**：capabilities/skills 路由、worker 级 token、独立心跳端点、WebSocket、8 态状态机、`task_assignments`/`worker_heartbeats` 表、逐工具事件同步。agentdock 对应物见 §1.3 的不照搬表。

---

## 1. agentdock 参考要点（保留路径，实现时可回查）

### 1.1 注册与身份（只抄形状）

- 路由：`server/cmd/server/router.go:1448` `r.Route("/api/daemon")` → `:1451 POST /register`（`handler/daemon.go:398 DaemonRegister`）、`:1452 /deregister`、`:1453 /heartbeat`、`:1471 /tasks/claim`。
- 幂等注册：`pkg/db/queries/runtime.sql:49 UpsertAgentRuntime`，唯一键 `(workspace_id, daemon_id, provider)`（`migrations/004_agent_runtime_loop.up.sql:14`）。
- 令牌：`internal/auth/jwt.go:70 GenerateDaemonToken`，库里**只存 SHA-256**（`jwt.go:92 HashToken`）；鉴权 `middleware/daemon_auth.go:79 DaemonAuth`。
- 上下线：注册写 `status='online'`（`handler/daemon.go:471`）；心跳 15s（`internal/daemon/config.go:24 DefaultHeartbeatInterval`）；30s sweeper、`last_seen > 150s` 判死（`cmd/server/runtime_sweeper.go:159/:37`）。

### 1.2 派发与回传（核心参考）

- **pull 为主，push 只喊一声「有活」**：`daemon.go:4985 pollLoop` → `POST /tasks/claim`；任务入队后 `service/task.go:6904 NotifyTaskEnqueued` → `daemonws/hub.go:315` 发 `daemon:task_available` 帧（只带 `runtime_id/task_id`，daemon 收到后立即 claim）。
- **claim 原子 SQL**：`pkg/db/queries/agent.sql:769 ClaimAgentTask` —— 串行条件（同 issue 在跑则跳过）+ 并发上限（`service/task.go:3507 CountRunningTasks >= max_concurrent → no_capacity`）+ `FOR UPDATE SKIP LOCKED`（`:836`）。
- **上报按生命周期拆端点**：`handler/daemon.go` 里 `StartTask:3644`、`ReportTaskProgress:3711`、`CompleteTask:3788`、`FailTask:4503`、`AckTaskCancelled:4733`。
- **失败回队**：`service/task.go:5126 retryableReasons` 白名单 + `attempt/max_attempts`（`migrations/055_….up.sql:19-24`，默认 2）。
- 协议：HTTP/JSON（控制面）+ WebSocket（唤醒/RPC）；存储 PostgreSQL（sqlc）+ Redis；消息定义 `pkg/protocol/messages.go`、`events.go`。

### 1.3 明确不照搬（单机单用户 + 本次收窄）

| agentdock 复杂度 | 文件依据 | 本方案 |
|---|---|---|
| capabilities 头协商 + 拉式 skills/models 刷新 | `X-Client-Capabilities`、`client.go:627 ReportModelListResult` | **砍**。无路由需求，不声明能力 |
| 注册带版本/CLI 探测/多 runtime | `daemon/agents_probe.go`、`DaemonRegisterRequest` | **砍**。register 只要 `{name, kind}` |
| `max_concurrent_tasks` 字段 + daemon 槽位双层并发 | `agentconfig` 默认 6、`config.go:65` | **砍**。全局限 1（SPEC §9） |
| 独立 heartbeat 端点 + Redis liveness + 批量 flush | `handler/daemon.go:1060/1219`、`heartbeat_scheduler.go:101` | **砍**。liveness 附着在业务调用与任务 `touch` 上 |
| deregister/详细上下线 + legacy 合并 | `handler/daemon.go:931/754` | **砍**。下线 = 失联，sweeper 判死 |
| 逐条 WS 事件（`task:progress/message` 流） | `protocol/events.go:35-44` | **砍**。只做单行快照 UPDATE |
| 8 态状态机（`dispatched/deferred/waiting_local_directory`） | `migrations/128_….up.sql:6-16` | **砍**。SPEC 六态，claim 即 `running` |
| 三层租约 45/90/300s、任务级 token `mat_` | `service/task.go:193-196`、`jwt.go:83` | **砍**。一个 `lease_until`，全局 Bearer |
| workspace/RBAC/SKIP LOCKED/Redis/多副本 | §见 `middleware/workspace.go:161`、`agent.sql:836` | **砍**。SQLite 单写者事务即互斥 |
| WS 推送唤醒 | `router.go:1454`、`daemonws/hub.go:281` | **砍**。claim 2s 轮询 + tick 合并（§2.4） |
| 重试白名单分类器（6 reason + 3 套 backoff） | `task.go:5126/5164/5180` | **砍**。`retryable` 布尔 + `attempt/max_attempts`，默认 1 |

**照搬**：register/claim/complete/fail 端点形状；pull claim 串行+上限写进一条事务；token 只存 SHA-256；sweeper 判死节奏（30s 扫 / 90s stale）；上报按生命周期拆端点。

---

## 2. 四项最小设计

公共约定：全部走 `api.ts` 现有 `/v1/*` + Bearer + `{ok,data}`（`api.ts:122 startApiServer`、`:156` 鉴权、`:160` 路径分派）；业务逻辑收敛在新 `core/workers.ts` / `core/approvals.ts` / `core/tasks.ts` 纯函数，**进程内直调与 HTTP handler 共用一套**（一入口两层皮）。

### 2.1 任务派发（UFA/调度器 → worker）

**表/字段**：`tasks` 按 SPEC §2.1 原样，追加 5 列（`db.ts:98-122` try/ALTER 模式）：
`worker_id TEXT`（谁领的）、`claimed_at INTEGER`、`lease_until INTEGER`（ms 租约）、`attempt INTEGER DEFAULT 0`、`max_attempts INTEGER DEFAULT 1`。
新表 `workers`：
```sql
CREATE TABLE IF NOT EXISTS workers (
  worker_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'wa',
  status TEXT NOT NULL DEFAULT 'online',          -- online | offline（sweeper 写）
  registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```
**API 形状**：
```
POST /v1/workers/register   {name:"wa-local", kind:"wa"}
    → {worker_id, lease_seconds:120, claim_interval_ms:2000}
POST /v1/workers/:id/claim   {}          → {task:{…} | null}   （没活 data=null，200）
POST /v1/tasks/:id/touch     {worker_id} → {lease_until}        （执行中每 30s 续租 + 顺带刷 workers.last_seen_at）
POST /v1/tasks/:id/complete  {worker_id, result, artifact, note} → {task}
POST /v1/tasks/:id/fail      {worker_id, error, retryable}      → {task}  -- 回 pending 或置 failed
```
**时序**：UFA `createTask`（SPEC §3.3，写 `pending`）→ `wa/runner.ts` claim 循环 2s → `core/workers.ts claimNextTask(workerId)` 事务：`SELECT 最早 pending(start_at<=now) ORDER BY start_at,id LIMIT 1` → `UPDATE SET status='running', worker_id, claimed_at, lease_until, attempt=attempt+1 WHERE id=? AND status='pending'`（双保险防重复领）→ 返回任务体 → 起 `PiEngine.run`。
**文件落点**：`core/workers.ts`（`registerWorker/claimNextTask/touchTask/completeTask/failTask/sweepWorkers`，新建）；`wa/runner.ts`（注册+claim 循环，新建，SPEC §3.4 改造）；`api.ts`（新路由）；`engine.ts` **不动**；`queue.ts` **不动**（它管 UFA 唤醒，`Wake` 不是任务，见 §4）。

### 2.2 运行快照查询（状态/阶段/进度/产物，不含工具明细）

**表/字段**：不建新表、不建事件表。`tasks` 再加 1 列：
`stage TEXT NOT NULL DEFAULT ''`（阶段名自由文本：`prepare/working/review/done`）。
快照 = `status`（六态）+ `stage` + `note`（SPEC 已有，一句人话进度/卡点）+ `result/artifact`（SPEC 已有）+ `updated_at`，外加 `workers.last_seen_at/status`。
**API 形状**：
```
GET /v1/tasks/:id/snapshot
  → {task:{id,goal,status,stage,note,result,artifact,worker_id,lease_until,updated_at},
     worker:{worker_id,status,last_seen_at} | null}
GET /v1/tasks?status=&limit=     （SPEC §4 已有，列表即批量快照，看板 3s 轮询用）
POST /v1/tasks/:id/progress      {worker_id, stage, note?}   -- worker 侧唯一上报口
```
**上报纪律（替代逐条工具事件）**：只在**阶段切换**时调 `progress`，worker 端 ≥10s 节流；server 侧是**单行 UPDATE**（`core/tasks.ts updateTask`），不落历史。工具调用详情只进 WA 自己的 `jsonl` 执行日志（ARCH §6.3），不上行、不入 API。
**时序**：`wa/runner.ts` 在阶段边界 → `progress` → UPDATE 单行 → UFA/看板下次轮询即见新快照。
**文件落点**：`core/tasks.ts updateTask`（patch 加 `stage`）；`api.ts` 的 `snapshot/progress` 路由；`ops/tasks.ts`（看板只读封装）；`wa/runner.ts`（阶段节点上报）。

### 2.3 权限申请捕获与上呈（worker → 持久化 → 用户 → 回传）

**表/字段**（新表 `approvals`）：
```sql
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL, worker_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,                 -- 要动什么，如 "shell: npm publish"
  detail TEXT NOT NULL DEFAULT '', why TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | timeout
  decided_by TEXT, decided_at INTEGER,      -- 用户是谁、何时裁决
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
```
**API 形状**：
```
POST /v1/approvals            {task_id, worker_id, action, detail, why, timeout_s:600}
    → {id, status:"pending", expires_at}                 -- 成功即持久化 + 置 tick（§2.4）
GET  /v1/approvals/:id        → {id, status, decided_by, decided_at}   -- worker 2s 轮询；看板同用
GET  /v1/approvals?status=pending                        -- 看板只读（纯展示，无动作）
POST /v1/approvals/:id/decide {decision:"approved"|"rejected", by:"<user_id>"}
    → {id, status}                                        -- 只给 UFA 工具调用，Web 不提供
```
**时序**：WA 执行中触发权限需求（宿主 shell 等，挂在迁移计划 C9 的工具结束钩子 `onToolEnd` 同层）→ `core/approvals.ts createApproval()`（进程内直调 / 外部 worker 走 HTTP）→ 落 `approvals` + 置 tick → 唤醒 UFA（§2.4），UFA 在**飞书对话里向用户转述 action/detail/why** → 用户回「可以/不行」→ UFA 调 decide 工具写 `status/decided_by` → worker 轮询 `GET /v1/approvals/:id` 拿到 → 放行继续 / 中止并写回任务 `note`。**超时 `expires_at` = `timeout`（拒绝，fail-closed）**——继承 `core/approval.ts` 头三条硬规矩第 1 条。
**与现有 `core/approval.ts ApprovalGate` 的关系**：Gate 是**内存单条 + 审批房直连**（`ApprovalGate.pending:64`、`settle:135`），重启即丢、Web 不可见、且不挂任务。改造 = 把裁决**落库到 `approvals`**：`createApproval` 取代 `ask()` 的内存 Pending，`settle()` 的结果写表；审批房表情/「y 1」流程（`tryHandle:171`）和 UFA 对话裁决都变成同一张表的两个决策入口。**Web/看板只读展示 `GET /v1/approvals?status=pending`，任何审批动作不进 Web。**
**文件落点**：`core/approvals.ts`（新建：`createApproval/getApproval/listApprovals/decideApproval/sweepExpirations`）；`api.ts` 三路由；`agent/tools.ts` 增 UFA 工具 `approve/reject`（SPEC §6.1 工具清单追加）；`ops/approvals.ts`（看板只读）；`core/approval.ts`（`settle` 接落库）。

### 2.4 完成时的 pending tick（合并机制）

**存哪里**：`kv` 表（`db.ts:74` 已有，`k/v` 两列）一行：`k='ufa.pending_task_tick'`，`v`=置位时间戳（epoch ms）。**不用内存**（重启不丢），**不建新表**。SPEC 未定此项，本文补齐。
**置位（合并的关键）**：`completeTask/failTask/createApproval` 末尾，同一事务内：
```
INSERT INTO kv(k,v) VALUES('ufa.pending_task_tick', ?now)
  ON CONFLICT(k) DO NOTHING;          -- 只有「无标记→有标记」这一步 changes=1
```
仅当 `changes===1` 时才 `queue.enqueue(makeWake("task-updated"))`；`changes===0`（标记已在、UFA 未消费）**不再唤醒**。`WakeType` 需加一个值 `"task-updated"`（`types.ts:55`，改 union 即可）；`RunQueue.enqueue` 的同 type 合并（`queue.ts:26`）是第二道保险——即便极端时序下重复 enqueue，队列里也只会有一条待跑。
**消费（UFA 一次吃多条）**：`app.ts handleWake`（`app.ts:416`）遇到 `task-updated` 分支时：
1. 事务：`SELECT v FROM kv WHERE k='ufa.pending_task_tick'` → 记 `set_at` → **DELETE 该行**（先删后处理，期间新完成会重新置位并 enqueue 下一轮）；
2. 用 `set_at` 作游标一次查出：`tasks WHERE updated_at >= set_at`（done/failed/blocked 都算）+ `approvals WHERE status='pending'`；
3. 批量交给 `runUfa({trigger:"task-updated", ...})`（SPEC §3.1），UFA 一轮内把多条完成/待批一并转述给用户；无内容则空转退出。
**效果**：任务 A、B、C 在 UFA 空闲时先后完成 → 只有 A 置位成功并唤醒，B/C 只更新标记内容（DO NOTHING）→ UFA 跑一次读到 A+B+C；UFA 正在生成时完成 → 标记重新置位 + wake 排队，**本轮不打断**（SPEC B3/B4 语义原样成立）→ 本轮结束再消费一次。**任何情况下都不会「每次完成都唤醒一次」。**
**文件落点**：`core/tasks.ts` 增 `markPendingTick()/takePendingTick()`（事务原语）；`app.ts`（消费分支）；`types.ts`（WakeType 加值）；`queue.ts` 不改。

---

## 3. 与 docs/SPEC-UFA-WA.md 的对齐

| SPEC 条目 | 本方案处理 |
|---|---|
| §2.1 `tasks` 表 / 六态 | **原样保留**，只追加 6 列（`stage` + §2.1 的 5 列）。`status` 仍「只用于查询排序，不驱动状态机」——claim/complete 只是原子写字段 |
| §3.3 `core/tasks.ts` 六个 CRUD | **保留且是唯一读写入口**；`core/workers.ts/approvals.ts` 只调用它们 |
| §3.4 `startWa` 每 2s 直取 pending | 改为「注册 + `claimNextTask` 循环」，**取任务的 SQL 条件一字不变**；`并发=1` 变成全局配置而非写死 |
| §4 `/v1/tasks` 七接口 | 保留给 UFA/沙盒 `rb`；worker 领用与上报走 `/v1/workers/*` + `tasks/:id/progress|complete|fail|touch`；职责分开 |
| §5「WA 完成 → 触发 UFA (task-updated)」 | 即 §2.4 的 pending tick——**这是 SPEC 留白处的补齐**：合并存储在 `kv`，消费前先删、用 `set_at` 当游标 |
| §6.1 UFA 工具清单 | 追加 `approve/reject`（审批动作在 UFA/飞书，Web 无动作面） |
| §7 验收 A1–A17 | 全部保留，本文 §6 追加 W 系列 |
| §9 留空项（主动找用户、WA 并发>1） | 不受影响；`workers` 表连 `max_concurrent` 字段都没有，就是「并发=1 不开放」的字面落实 |
| Web 控制台 | 沿用「纯只读 + 3s 轮询」：新增 `GET /v1/tasks/:id/snapshot`、`GET /v1/approvals?status=pending` 只作展示；实际使用走飞书 |

---

## 4. 冲突点与改造顺序

**冲突点**（详见各节）：`core/queue.ts` 不动——`Wake` 不是任务、同 type 合并语义恰好服务 tick 合并，任务派发绝不进 RunQueue，只在 tick 置位时 enqueue 一次 `task-updated`；`agent/engine.ts` MVP 不动——唯一改动是权限钩子（`onToolEnd` 同层）改调 `createApproval`；`core/approval.ts` 从「内存 Pending」改为「落库 + 双入口裁决」；`api.ts` 只加路由不改旧路由（SPEC §0 红线）。

**改造顺序（每步一个 commit）**：
1. `db.ts`：`workers`/`approvals` 表 + `tasks` 6 列（纯 schema）。
2. `core/tasks.ts`：SPEC §3.3 CRUD + `stage` + `markPendingTick/takePendingTick`。
3. `core/workers.ts` + `core/approvals.ts`：claim 事务、sweeper（30s：`last_seen>90s` → worker offline；`lease_until` 过期的 running 回 pending 并 appendNote）、审批过期=拒绝。
4. `api.ts` 新路由（§2.1/2.2/2.3 全部）+ `ops/tasks|workers|approvals.ts` 只读封装。
5. `wa/runner.ts`（注册/claim/阶段上报/touch/轮询审批）+ `types.ts` WakeType + `app.ts` tick 消费与 sweeper 接线 + 权限钩子接 `createApproval`。
6. 验收测试（A1–A17 回归 + W 系列）。

---

## 5. 端到端时序（派发 → 领取 → 快照 → 权限 → 回传 → tick）

```
① UFA 登记任务    agent/tools.ts create_task → core/tasks.ts createTask → INSERT tasks(pending)
② worker 领取      wa/runner.ts claimLoop → core/workers.ts claimNextTask（api.ts 为外部 worker 提供同名路由）
                   → 事务：最早 pending → 置 running + worker_id/lease_until/attempt+1
③ 执行与快照      engine.ts PiEngine.run；阶段切换 → POST /v1/tasks/:id/progress → updateTask 单行 UPDATE
                   （工具明细只进 jsonl，不上行）；每 30s POST /v1/tasks/:id/touch 续租
④ 权限申请        工具钩子 → core/approvals.ts createApproval → 落库 + markPendingTick
                   → （changes=1 才）queue.enqueue(makeWake("task-updated"))   [queue.ts:26 合并兜底]
⑤ UFA 消费        app.ts handleWake(task-updated) → takePendingTick（删行取 set_at）
                   → 批查 updated_at>=set_at 的 tasks + pending approvals → runUfa 一轮转述（飞书）
⑥ 用户裁决        用户在飞书回话 → UFA 调 approve/reject 工具 → decideApproval 写 status/decided_by
⑦ worker 放行     轮询 GET /v1/approvals/:id 拿到 → 继续 / 中止写回 note
⑧ 完成回传        core/workers.ts completeTask → tasks: done/result/artifact/end_at
                   → markPendingTick（同④，多任务完成只产生一个标记）→ 一次 task-updated 唤醒
⑨ 兜底            app.ts 30s sweeper → sweepWorkers：失联判死、lease 过期回队、审批过期置 timeout
```

---

## 6. 验收断言（追加到 SPEC §7 后）

- [ ] **W1** 两个并发 claim 不会领到同一任务；无 `start_at<=now` 的 pending 时 `claim` 返回 `data.task=null`（200）。
- [ ] **W2** `GET /v1/tasks/:id/snapshot` 能看到 `status/stage/note/artifact`；**API 响应与库中不存在任何逐条工具事件记录**。
- [ ] **W3** worker 发起权限申请后：`GET /v1/approvals?status=pending` 可见（看板只读）；Web 无任何 approve 入口；UFA 决定后 worker 轮询拿到结果；超时后 `status='timeout'` 且 worker 按拒绝处理。
- [ ] **W4** 三任务先后完成 → `kv` 只有一次 0→1 置位、`RunQueue` 至多一条 `task-updated` 待跑；UFA 一轮读到三条（`updated_at >= set_at` 游标生效）。
- [ ] **W5** UFA 运行期间完成的任务不触发打断，本轮结束后下一轮被消费（B3/B4 不回归）。
- [ ] **W6** worker 失联 90s → `workers.status='offline'`，其 running 任务 lease 过期回 pending 且 `note` 有记录；`GET /v1/workers` 可见。
