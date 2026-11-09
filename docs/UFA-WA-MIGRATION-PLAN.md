# UFA-WA 改造落地计划

> 基线：`origin/main` @ `d1e57cc`（2026-11-09）。
> 目标：在现有 PiEngine + Scheduler + SQLite 上小步改成 UFA/WA 双 runner，不推倒重写。
> 本文只写计划，不改代码。所有“现状”都来自当前仓库源码，引用处给了文件和函数。

---

## 1. 结论先行

### 1.1 必须先做

1. **`tasks` 表 + Store CRUD + 只读 API（P0）**
   理由：`tasks` 是 UFA/WA 唯一交接面。现在没有这张表，`core/db.ts` 里只有 `plans`/`plan_fires`，任何双 runner 都只能继续借 `plans`，后面一定要重做。先落表、先跑 `A7/A8/A9`，不改变现有唤醒行为，风险最低。

2. **拆工具集、拆引擎实例、拆队列（P1 的 WA 部分）**
   理由：当前 `app/src/agent/tools.ts:63` 的 `createTools()` 一次性返回 `chat + memory + plan + read_file + write_file(可选) + terminal + rb`；`app/src/agent/engine.ts:84` 的 `PiEngine` 构造时绑定 `systemPrompt` 和 `tools`，只有一个主 session 和一个 `seenPools`；`app/src/app.ts:100` 只有一个 `RunQueue`。不拆这三处，“双 runner”只是两个名字共用一套会话和工具。必须先把 WA 做成独立引擎实例 + 独立串行循环。

3. **WA 串行执行 + 任务回写 + 取消检查（P1）**
   理由：UFA 只有在 WA 能稳定回写 `result/artifact/note` 之后才有意义。当前 `PiEngine.run()` 没有“每次工具调用结束”的回调，无法实现 SPEC 的“当前工具调用结束后停止”；必须补 `RunLimits.onToolEnd` 或在 `runPrompt()` 的 `tool_execution_end` 分支加钩子。

4. **UFA 入口从 scheduler 的“未读唤醒”改为消息直达（P2）**
   理由：`app/src/core/hub.ts:69` 现在把消息交给 `Scheduler.onMessage()`，群聊默认等 tick；`app/src/core/scheduler.ts:171` 还会把所有未读池一起入队；`proactivePools` 和 `reflection` 会定时唤醒。ARCH 2.1 明确“只有用户发消息才触发 UFA，没有消息不唤醒”。不改入口就会双唤醒、延迟、并继续被 tick 合并。

### 1.2 可以后做

1. **UFA 30 秒窗口（P2 的后半段）**
   不是第一刀。先把“每条消息都能触发 UFA、UFA 能登记任务”跑通，再加窗口；否则窗口会掩盖入口链路的问题。窗口模块 `ufa/window.ts` 可以独立开发和测试。

2. **记忆 `kind_ext` 与 `asOf` 命名对齐（P3）**
   当前 `app/src/core/db.ts:55-62` 和 `:119-122` 已经有 `valid_from / valid_to / superseded_by`，`app/src/ops/memories.ts:35-76` 的 `addMemory` 已支持 `from/until/supersede`，`app/src/api.ts:144-166` 已支持按 `at` 查询。SPEC 2.2 的四个字段里只差 `kind_ext`；而 `valid_to` 已经能表达“plan 到期失效”。先确认是否真的需要 `kind_ext`，不要为了对齐 SPEC 加一个重复字段。

3. **`plans → tasks` 正式迁移（P4）**
   SPEC 2.3 自己也说 `plans / plan_fires` 保留读不写、等 `tasks` 跑通一周再删。迁移可以晚于 P0/P1/P2；在 P0-P3 期间 `plans` 继续服务旧计划链，避免一次性拆掉仍在工作的定时提醒。

4. **Web 控制台的任务面板（P0 之后）**
   控制台先只读展示 `GET /v1/tasks`，不要先做创建/取消/改状态。任务模型只放后端 `core/tasks.ts`，控制台不复制一套状态机。

### 1.3 建议不做

1. **不要给 UFA 暴露原始 SQL 查询工具。**
   SPEC 6.1 写“search_messages（SQL）”，但当前没有 SQL 工具，现有 `chat` 的 search 走 `ops/pools.searchPool()` 的 LIKE。给模型裸 SQL 会同时带来注入和越权读取（跨池/跨用户）风险。建议做结构化参数：`pool`、`sender`、`time range`、`keyword`，后端拼参数化 SQL。

2. **不要在 P4 之前 `DROP TABLE tide_events` 或删除 `plans`。**
   当前 `tide_events` 仍被 `PlanEngine.due()`、`prompt.wakePrompt()`、`db.countTideFired/lastTideFired` 读写；`localDay()` 还被 `core/idle.ts:17,123,189` 使用。直接删会先断编译，再丢历史判断数据。建议先停止写入、归档表、保留只读，最后再删。

3. **不做 WA 并发 > 1，不把 WA 拆成独立进程。**
   当前单实例锁在 `app/src/main.ts:45`，审批序号和 `approval.jsonl` 也依赖单进程。WA 先在一个进程内串行跑，最省事，也符合 SPEC 0 和 3.4。

4. **不重写 PiEngine，不引入第二套 agent 框架。**
   现有 `PiEngine` 的 session、handoff、工具调用、usage 记账已经能用。两个 runner 用两个 `PiEngine` 实例（不同 systemPrompt/tools/session 目录）即可，不需要换 opencode/pi 之外的框架。

5. **暂不做主动找用户的新设计。**
   ARCH 第 7 节明确“主动机制重新设计，暂不定”。当前 `proactive` + `reflection` + `gate` 还在跑，改造期间建议先关掉或保持休眠，不要一边改双 runner 一边重做主动策略。

---

## 2. 现状盘点

| 模块 | 现在是什么 | SPEC 要求 | 差距 | 改动文件 |
|---|---|---|---|---|
| 单 agent → UFA/WA 双 runner | 一个 `PiEngine`，一个主 session；`app/src/agent/engine.ts:84-119` 构造时绑定 `systemPrompt` 和 `tools`；`app/src/app.ts:118` 只 new 一个引擎 | UFA/WA 各自独立会话，UFA 接人、WA 干活，互不共享上下文 | 没有双实例；`session`、`seenPools`、`pendingHandoff` 都是单份；`reflect()` 只是独立无工具会话，不能当第二 runner | `app/src/agent/engine.ts`、`app/src/app.ts`、新增 `app/src/ufa/runner.ts`、`app/src/wa/runner.ts` |
| 提示词拆分 | `agent/prompt.ts:11 systemPrompt()` 把人格 + 干活规则生成一份 `system.md`；`wakePrompt()` 统一拼所有场景；模板在 `app/data/sandbox/prompt/system.md`、`wake.md`、`scene-*.md` | `ufa-system.md` / `wa-system.md` / `ufa-scene-*` / `wa-scene-*` 分开 | 现在只有一份系统提示词；UFA 的人格和 WA 的效率规则混在一起；场景文件也只有 `scene-message/tick/plan` | `app/src/agent/prompt.ts`、`app/src/agent/template.ts`、`app/data/sandbox/prompt/*`、新增 `ufa/wa` 提示词文件 |
| tasks 面板 | 没有 `tasks` 表；只有 `plans`（`app/src/core/db.ts:29-33`）和 `plan_fires`（`:54`） | 新表 `tasks`，字段见 SPEC 2.1；`createTask/getTask/listTasks/updateTask/appendNote/cancelTask` | 缺表、缺类型、缺 CRUD、缺 API；`plans` 字段和任务面板语义不同（无 `deliverable/constraints/acceptance/files/result/artifact`） | `app/src/core/db.ts`、新增 `app/src/core/tasks.ts`、`app/src/types.ts`、`app/src/api.ts`、`app/src/ctl.ts` |
| tasks 状态流转 / 定时 / 交接 | `PlanEngine.due()` 每 tick 处理 `plans`，用 `plan_fires` 去重，用 `tide` 闸门决定发不发（`app/src/core/plans.ts:67-119`）；`status` 有 `pending/done/cancelled/expired` | `tasks.status` 六态，只用于查询/排序，不驱动状态机；`start_at` 未来=定时；WA 每 2s 取 `pending AND start_at<=now` 第一条；取消只置状态 | 没有 `tasks`；现有 `plans` 的 `once/cron/none` 和 `expires_at` 不能直接塞进 `start_at`；`due()` 仍会走 tide 闸门 | `app/src/core/plans.ts`、`app/src/core/db.ts`、新增 `app/src/core/tasks.ts`、`app/src/wa/runner.ts` |
| memories 时间维度 | 已经有 `valid_from/valid_to/superseded_by`（`app/src/core/db.ts:55-62`，旧库补列 `:119-122`）；`ops/memories.ts` 支持 `from/until/supersede`、`closeMemory`、`updateMemory`；`visibleMemories` 支持 `at/includeExpired`（`db.ts:615-641`） | 加四个字段，`searchMemories({userId, asOf, query, limit})`；`kind='plan'` 带 `kind_ext` 到期时间 | 只差 `kind_ext`；函数签名是 `searchMemories(store, { user, at, ... })`，不是 `asOf`；API 参数是 `at` 不是 `asOf`；但 `valid_to` 已能表达到期 | `app/src/core/db.ts`、`app/src/ops/memories.ts`、`app/src/api.ts`、`app/src/agent/tools.ts` |
| plans → tasks 迁移；tide/energy/wave 删除面 | `plans` 被 `PlanEngine`、`Scheduler.tick()`、`prompt.wakePrompt()`、`plan` 工具、`/v1/plans`、`ctl plans`、`sim.ts` 使用；`tide.ts` 被 `plans.ts`、`prompt.ts`、`idle.ts` 使用；源码里没有 `core/energy.ts` 或 `core/wave.ts`，只有文档/配置/字段残留 | `plans.ts` 删，`energy/tide/wave` 删，`tide_events` 删；`plans/plan_fires` 先保留读不写 | 删除面比 SPEC 想的大：`localDay()` 还被 `idle.ts` 用；`plans` 是现有定时提醒的唯一实现；`tide` 仍在 `PlanEngine.due()` 里做闸门 | `app/src/core/plans.ts`、`app/src/core/tide.ts`、`app/src/core/db.ts`、`app/src/core/idle.ts`、`app/src/app.ts`、`app/src/core/scheduler.ts`、`app/src/agent/prompt.ts`、`app/src/agent/tools.ts`、`app/src/api.ts`、`app/src/ctl.ts`、`app/src/sim.ts`、`app/src/config.ts`、相关测试 |
| 唤醒链路（scheduler/queue/gate/reflection） | `Hub.ingest()` → `Scheduler.onMessage()`（`hub.ts:69`）；私聊去抖直接唤醒，群聊等 tick；`Scheduler.tick()` 把 `duePlans`、`proactivePools`、`poolsWithUnread` 一起入 `RunQueue`（`scheduler.ts:153-176`）；`app.ts:124` 起 reflection 定时器；`app.ts:144 proactivePools` 六道门 | UFA 只由用户消息触发；WA 由任务 `start_at` 触发；不轮询；面板更新非打断唤醒 UFA | 当前 tick 会定时唤醒、会把多池未读合并、会做主动开口；`RunQueue` 单队列会串行化 UFA 和 WA；`reflection/gate` 与 ARCH 2.1 冲突 | `app/src/core/scheduler.ts`、`app/src/core/queue.ts`、`app/src/core/hub.ts`、`app/src/app.ts`、`app/src/core/reflection.ts`、`app/src/core/gate.ts`、`app/src/config.ts` |
| API 与 Web 控制台 | `app/src/api.ts` 已有 Bearer token 的 `/v1/pools`、`/v1/plans`、`/v1/memories`、`/v1/images`、`/v1/web`、`/v1/skills`、`/v1/sandbox/*`；没有 `/v1/tasks`；没有静态页面 | API 只加不改：`GET /v1/tasks`、`POST /v1/tasks`、`GET /v1/tasks/:id`、`POST /v1/tasks/:id/note`、`POST /v1/tasks/:id/cancel`、`POST /v1/tasks/:id/status`、`GET /v1/memories?asOf=` | 缺 tasks 路由；缺 `asOf` 别名；另一个任务正在加 Web 静态页和 `POST /v1/pools/:ref/messages`，会和 `api.ts` 的 switch/`ApiDeps` 冲突 | `app/src/api.ts`、新增 `app/src/ops/tasks.ts`、`app/src/main.ts`（控制台任务会改）、`app/web/*`（另一个任务） |
| 审批 / exec 新能力 | `core/cmd-rules.ts` 分类 + `core/approval.ts` 闸门 + `agent/tools.ts:418-479 terminal` 接线；host 模式才走审批；`app.ts:92` 构造 `ApprovalGate`，日志写 `data/approval.jsonl`；`config.approval` 默认 `enabled:false`；`exec.shell.mode` 默认 `docker`；host 模式下 `createTools()` 不返回 `write_file`（`tools.ts:520-522`） | WA 用全量工具（shell/文件/网络）；UFA 不给 shell、网络、图片处理；审批/exec 只服务真正干活的 WA | 现在是单 agent 共用；WA 还没独立工具集；UFA 如果直接复用会拿到 `terminal`；host 模式下 `write_file` 被全局裁掉，和 UFA 需要 `write_file` 冲突；审批日志是 JSONL，不是 SPEC-host-shell 里的 `approval_log` 表 | `app/src/agent/tools.ts`、`app/src/core/approval.ts`、`app/src/core/cmd-rules.ts`、`app/src/core/shell-runner.ts`、`app/src/ops/exec.ts`、`app/src/config.ts` |
| 运行队列 / 单实例 | `app/src/core/queue.ts` 单 FIFO，同类型唤醒合并；`main.ts:45` 单实例锁；`main.ts:103` 起 API | UFA 和 WA 各跑各的；WA 串行；UFA 不因 WA 长任务被阻塞 | 一个 `RunQueue` 同时承载消息、计划、主动、后续的 WA 任务；WA 长任务会卡住 UFA 回复 | `app/src/core/queue.ts`、`app/src/app.ts`、`app/src/main.ts`、新增 `app/src/ufa/runner.ts`、`app/src/wa/runner.ts` |
| UFA 专属读能力 | `read_file` 通过 `readSandboxFile`，上限取全局 `exec.maxReadChars`（默认 8000，`config/default.json`）；`chat` 的 search 是单池 LIKE；`rb` 有 `pool-read/pool-search`，没有 SQL | UFA `read_file` 单次 ≤500 字符；`search_messages`（SQL）；`search_memories/write_memory` | 没有 500 字上限的 UFA 读工具；没有 SQL 工具；`chat` 是给聊天 agent 的，不是 UFA 的查询接口 | `app/src/agent/tools.ts`、`app/src/ops/exec.ts`、`app/src/core/sandbox-fs.ts`、新增 UFA 工具 |

### 2.1 两个容易看错的现状

1. **记忆时间维度不是从零开始。** `db.ts` 的 `SCHEMA` 已经包含三列，构造函数还会给老库补列；`memory-validity.test.ts` 已经覆盖“改口、按时间点查、until 到期、只关不顶”。P3 不要再写一遍“加三列”的迁移，重点只剩 `kind_ext`、`asOf` 别名和“plan 型记忆到期”的语义。

2. **审批能力已经落地，但默认没开。** `config/default.json` 里 `exec.shell.mode` 是 `docker`、`approval.enabled` 是 `false`；`tools.ts:440-461` 只在 `mode === "host"` 时分类和等批。WA 改造不需要重写审批，只需要保证 `terminal` 只进 WA 的工具集，并且继续把 `ApprovalGate` 传给 WA 的 `createTools`。

---

## 3. SPEC 与当前代码的真实冲突

下面每条都不是“文案不一致”，而是照着 SPEC 直接写会撞上的实现问题。

### C1. 单 `PiEngine` 不能同时当 UFA 和 WA

**现状**
`PiEngine` 有唯一的 `session`、`seenPools`、`pendingHandoff`（`engine.ts:85-88`）。`run()` 和 `reflect()` 共用同一个 `piDir/cwd/sessionDir`（`engine.ts:97-101`）。`systemPrompt` 和 `tools` 在构造函数里固定（`engine.ts:97,108-126`）。

**冲突**
SPEC 1 说“engine.ts 保留，改成可传入不同 system prompt + 工具集”，但当前不是“每次 run 传入”，而是“实例级绑定”。如果两个 runner 共用一个实例，UFA 的人格会被 WA 的任务上下文污染，`seenPools` 也会互相影响。

**处理建议**
- 不重写 engine：让 `PiEngineDeps` 增加 `namespace: "ufa" | "wa"`，把 `piDir/cwd/sessionDir` 按 namespace 分开；两个 runner 各 new 一个实例，各自持有 systemPrompt/tools。
- 或者新增 `UfaEngine`/`WaEngine` 薄包装，内部仍是两个 `PiEngine` 实例。
- `reflectSession` 继续只属于 UFA（主动机制若保留），不要给 WA。

### C2. 单 `RunQueue` 会让 WA 长任务卡住 UFA

**现状**
`app.ts:100` 的 `this.queue = new RunQueue((w) => this.handleWake(w))` 是唯一队列；`queue.ts:26-37` 同类型合并，`pump()` 一次只跑一个 handler。

**冲突**
SPEC 0 要求 WA 串行，但 ARCH 2.3/B3/B4 要求“UFA 正在生成时来消息先记账，生成完再处理”“WA 回写任务时 UFA 正在生成就等 UFA 结束”。如果 UFA 和 WA 共用 `RunQueue`，WA 跑一个 10 分钟构建时，UFA 完全不能回消息。

**处理建议**
- UFA 用独立队列（`UfaQueue`，单并发，按 pool 保序）。
- WA 用独立 `WaRunner`（自己 `setInterval` 2s，单并发）。
- 旧 `RunQueue` 只服务过渡期的 `plan/proactive`，P4 删掉。
- 不要用同一个 `Wake` 类型硬塞两种语义；新增 `UfaEvent`/`WaEvent` 更清楚。

### C3. host 模式全局裁掉 `write_file`，但 UFA 需要它

**现状**
`tools.ts:520-522`：`const sandboxed = d.cfg.exec.shell.mode !== "host"; return [chat, memory, plan, readFile, ...(sandboxed ? [writeFile] : []), runShellTool, rb];`
也就是说 host 模式下没有 `write_file`，写盘只能走 `terminal` → 审批。这是 `SPEC-host-shell-approval.md` 的“沙盒收口”决定的。

**冲突**
ARCH 职责表要求 UFA 有“文件写（无上限）”，SPEC 6.1 也把 `write_file` 给 UFA，但不给 UFA `terminal`。如果照现在的 `createTools` 裁，UFA 在 host 模式下既没有 `terminal` 也没有 `write_file`，无法写任务描述。

**处理建议**
- 把“是否注册 `write_file`”从全局改成 profile：`createUfaTools()` 始终注册 `write_file`，但底层只允许写 `cfg.exec.dir` 沙盒根，路径校验走 `createSandboxFs`；它不经过宿主机 shell，所以不需要审批。
- WA 继续遵守 host 模式“写盘走 terminal + 审批”，即 `createWaTools()` 不注册 `write_file`。
- 这是一个有意的例外：UFA 的写是“写任务描述到沙盒”，不是“改宿主机任意文件”；不要让 UFA 拿到 `terminal`。

### C4. SPEC 的 JSON 输出契约和现在的“工具调用即输出”不一致

**现状**
`engine.run()` 返回 `assistantText` 和 `toolCalls`（`engine.ts:178-193`）。当前聊天机器人唯一输出通道是 `chat` 工具（`tools.ts:83-196`），普通 assistant 文本只进日志。`system.md:42` 也明确“只有 chat send 才会出现在聊天里”。

**冲突**
SPEC 5.1 定义 UFA 返回 `{type:"reply"}` / `{type:"defer"}` / `{type:"reply", tasks:[...]}`。这是“解析模型文本”的契约；当前架构是“模型调工具”。如果直接按 SPEC 解析 JSON，会和现有工具调用循环打架。

**处理建议**
- 保留工具调用架构，新增两个 UFA 工具：`defer(ms)` 和 `create_task(...)`；`runUfa()` 读 `res.toolCalls`：有 `defer` 就开窗口，没有 `defer` 就要求本轮至少有一次 `chat.send`（或返回错误让她重来）。
- 如果坚持 SPEC 的 JSON 契约，则必须新增“UFA 输出解析器”，并关闭 UFA 的 `chat` 工具；这比加两个工具改动大，不建议第一版做。
- 无论哪种，`tasks` 不能靠模型在普通文本里写 JSON 再猜；任务登记必须走 `create_task` 工具或 API。

### C5. `plans` 的字段/语义装不进 `tasks`

**现状**
`plans` 有 `title/content/pool_id/schedule_kind/schedule/status/expires_at/created_at/updated_at/anchor_kind/why`（`db.ts:29-33` + 旧库补列 `:100-104`）。`pool_id` 可空；`schedule_kind` 支持 `once/cron/none`；`status` 是 `pending/done/cancelled/expired`；没有 `user_id`、`deliverable`、`constraints`、`acceptance`、`files`、`result`、`artifact`。

**冲突**
SPEC 2.1 的 `tasks` 要求 `user_id NOT NULL`、`pool_id NOT NULL`、`start_at NOT NULL`，没有 cron/expires 字段。直接“plans 全部迁 tasks”会丢三类信息：全局计划（`pool_id=NULL`）、重复计划（cron）、过期时间（`expires_at`）。

**处理建议**
- `once` + `pool_id != null`：迁 `tasks`，`start_at = Date.parse(schedule)`。
- `cron`：P4 前继续留在 `plans`（只读/不新增），不要硬塞进 `tasks`。如果产品坚持要迁，必须在 `tasks` 加 recurrence 字段，但这就违反 SPEC“不加更多字段”，应另开 SPEC。
- `pool_id = null`：不迁 `tasks`，保留在 `plans` 并标记 `migrated_skipped`；不要造假 `pool_id`。
- `expires_at`：迁 `tasks` 时写进 `note`，或在迁移报告中单独列出；`tasks` 不新增列。
- `user_id`：用 `store.lastUserId(pool_id)`；取不到时用 `u_migrated` 并在 `note` 标明，不要留空（`tasks.user_id NOT NULL`）。

### C6. SPEC 说“删 plans/tide”，但当前删除面会先断编译

**现状**
- `plans.ts` 被 `app.ts:99,104,462`、`scheduler.ts:158`、`prompt.ts:54,100-120`、`tools.ts:21,313-369`、`api.ts:18,131-143`、`ctl.ts:55`、`sim.ts:67-73` 使用。
- `tide.ts` 的 `localDay()` 被 `core/idle.ts:17,123,189` 使用；`canFire/anchorOf` 被 `plans.ts` 使用。
- `tide_events` 被 `db.ts:451-464`（`countTideFired/lastTideFired`）和 `prompt.ts:97-99` 使用。

**冲突**
SPEC 1 的模块图写 `core/plans.ts ← 删`、`energy.ts/wave.ts/tide.ts ← 删`，但 SPEC 2.3 又说“`plans / plan_fires` 保留读不写，等 `tasks` 跑通一周再删”。两处自相矛盾；按前者做会立刻破坏现有定时提醒、API、CLI 和测试。

**处理建议**
- 把“删”拆成三步：停写 → 只读 → 归档/删表。
- 先做 P4 的“停写”：`plan` 工具改为 `create_task`，`/v1/plans` 保留只读，`PlanEngine.due()` 不再产生新计划。
- `localDay()` 先搬到 `core/time.ts`（或 `time.ts` 新增导出），再删 `tide.ts`；`idle.ts` 跟着改 import。
- `tide_events` 先停止写入，表改名为 `tide_events_archived`（或保留只读），确认一周无读后再 `DROP`。
- 不要在 P0-P3 删任何旧文件；P4 单独一个 commit。

### C7. 记忆时间维度已经实现，SPEC 的 `kind_ext` 与 `asOf` 是重复/命名冲突

**现状**
`db.ts:55-62` 已有三列；`addMemory` 支持 `valid_from/valid_to/supersede`；`visibleMemories` 已按 `COALESCE(valid_from, created_at) <= at AND (valid_to IS NULL OR valid_to > at)` 查询（`db.ts:625-630`）；`ops/memories.ts:90-109` 返回 `from/to/replaced_by`。

**冲突**
SPEC 2.2 要求 `ALTER TABLE memories ADD COLUMN ... kind_ext`，并定义 `searchMemories({ userId, asOf, query, limit })`。当前没有 `kind_ext`；`valid_to` 已经能表达“到期失效”；函数是 `searchMemories(store, { user, at, ... })`。照 SPEC 再加一套会和现有 `until` 语义重叠，还会多一个没人读的列。

**处理建议**
- 默认不新增 `kind_ext`：`kind='plan'` 的到期时间写 `valid_to`，`addMemory` 的 `until` 已经支持。
- 如果确实需要“plan 的到期时间”和“记忆失效时间”分开，才加 `kind_ext`，并明确“检索仍只看 `valid_to`”；否则不加。
- API 增加 `asOf` 查询参数作为 `at` 的别名（只加不改），内部统一转成 `at`；不要改现有 `at` 的行为。
- 不做自动 supersede；ARCH 4.3 明确“写入的人自己说”。现有 `addMemory` 的 `supersede` 已经是正确形状。

### C8. ARCH 说“没有消息就不唤醒”，当前 tick/proactive 仍在定时唤醒

**现状**
`config/default.json`：`scheduler.tickMs=180000`、`activeTickMs=60000`、`batchToTick=true`、`directPrivate=true`；`proactive.enabled=true`。`scheduler.ts:153-176` 每 tick 检查计划、主动池、未读池；`app.ts:124` 起 reflection 循环；`app.ts:144 proactivePools` 每 tick 评估六道门。

**冲突**
ARCH 2.1 明确“只有用户发消息才触发 UFA 识别。没有消息就不唤醒，不做定时轮询”；SPEC 0 也写“不做主动找用户”。当前单 agent 就是靠 tick + proactive 驱动的。UFA 如果继续走这条路，30 秒窗口和“每条都触发”都无法保证。

**处理建议**
- P2 起，UFA 入口只挂 `Hub.ingest()`：消息入库后直接投递到 `UfaQueue`，不再经过 `Scheduler.onMessage()` 的 tick 合并。
- `Scheduler` 在过渡期只保留给旧 `plans` 和 WA 的定时检查；`proactivePools` 和 `reflection` 用配置开关关掉（`proactive.enabled=false`），不要先删代码。
- 等 UFA 跑稳后，P4 再删 `reflection/gate/proactive` 的接线；`PLANS/SPEC` 里“主动机制暂不定”保持一致。

### C9. 取消检查缺少引擎钩子

**现状**
`engine.runPrompt()` 在 `subscribe` 里只收集 `tool_execution_end`（`engine.ts:228-232`），没有对外回调；`RunLimits` 只有 `tokensLeft/callsLeft/forceHandoff`（`engine.ts:41-46`）。`abort()` 只由 token/call/turn timeout 触发（`engine.ts:252-256`）。

**冲突**
SPEC 3.4 要求“每完成一次工具调用检查一次 `tasks.status`，是 `cancelled` 就在这一步结束后停”。当前没有这个检查点，只能整轮 abort 或等跑完。

**处理建议**
- `RunLimits` 加可选 `onToolEnd?: (info: { name: string; isError: boolean }) => string | null`；在 `runPrompt()` 的 `tool_execution_end` 分支调用，返回非空字符串就 `abort(reason)`。
- WA runner 传 `onToolEnd: () => store.getTask(id)?.status === "cancelled" ? "task-cancelled" : null`。
- 注意 `s.abort()` 仍可能在工具调用之后的下一次生成开始时生效；任务回写要把“停在哪、有没有半成品”写进 `note`。

### C10. UFA 的 500 字读取和 SQL 查询都没有现成实现

**现状**
`read_file` 走 `readSandboxFile` → `createSandboxFs({ maxReadChars: cfg.exec.maxReadChars })`（`ops/exec.ts:10-18,57-60`），默认 8000；`chat` 的 search 走 `ops/pools.searchPool()` 的 LIKE；`rb` 只有 `pool-read/pool-search`，没有 SQL。

**冲突**
SPEC 6.1 要求 UFA `read_file` 单次 ≤500 字符、`search_messages` 支持 SQL。直接给现有 `read_file` 改全局上限会影响聊天 agent；直接加 SQL 工具会开越权口子。

**处理建议**
- 新增 UFA 专用 `read_file` 包装：调用 `readSandboxFile` 后截到 500 字符，并在返回里带“已截断，完整路径 X”；不要改全局 `exec.maxReadChars`。
- `search_messages` 不暴露原始 SQL，提供结构化过滤：`pool`、`sender`（self/other）、`since`、`until`、`keyword`、`limit`；后端用参数化 SQL。若确实要 SQL，只允许 `SELECT` 且必须在服务端加池/用户白名单，不建议第一版做。
- UFA 的 `write_memory` 复用 `ops/memories.addMemory`，不要新写一套。

---

## 4. 分阶段实施计划

### 4.0 串并行总览

| 阶段 | 内容 | 依赖 | 可并行 |
|---|---|---|---|
| P0 | `tasks` 表 + CRUD + 只读 API | 无 | `tasks` schema/模块可与 Web 控制台静态页并行；`api.ts` 的路由改动要和 Web 任务串行合并 |
| P1 | WA runner（串行）+ 任务执行 | P0 | 工具集拆分、`onToolEnd` 可并行；WA 集成要等 P0 API |
| P2 | UFA runner + 30s 窗口 | P1（需要任务回写和 `create_task`） | `ufa/window.ts`、UFA/WA 提示词可与 P1 后半并行；入口接线必须等 P1 稳定 |
| P3 | 记忆时间维度收尾 | 可与 P2 并行（不同文件） | `ops/memories.ts`/`db.ts` 与 `prompt.ts` 有交叉，建议 P2 后做 |
| P4 | 删旧模型 / 迁移数据 | P0-P3 全部验收 + `tasks` 跑一周 | 无；必须最后做 |
| Web 控制台 | 任务面板只读 | P0 的 `GET /v1/tasks` | 前端可先做列表壳；任务接口合并要串行 |

**必须串行的**：P0 → P1 → P2 → P4。原因是 `tasks` 表、WA 回写、UFA 唤醒、删除旧模型是一条数据链。
**可以并行的**：`ufa/window.ts` 与 `wa/runner.ts` 的单元测试；提示词文件编写与 runner 代码；`ops/memories.ts` 的 P3 改造与 P2 的 UFA 入口（只要不同时改 `api.ts`/`prompt.ts`）。

---

### P0：任务面板 + API 只读

**目标**
把 `tasks` 表、类型、Store CRUD 先落地；只加 `GET /v1/tasks`、`GET /v1/tasks/:id`，不改现有唤醒/发送行为。给 P1 的 WA runner 一个可用的数据面。

**改动文件**
- `app/src/core/db.ts`
  - `SCHEMA` 增加 `tasks` 表和 `idx_tasks_status`、`idx_tasks_start`（照 SPEC 2.1 原文）。
  - 构造函数只做 `CREATE TABLE IF NOT EXISTS`，不迁移旧表。
  - Store 方法：`createTask()`、`getTask()`、`listTasks(filter)`、`updateTask(id, patch)`、`appendNote(id, line)`、`cancelTask(id)`、`claimNextTask(now)`（P1 用，P0 可先不暴露）。
  - 所有写操作更新 `updated_at`；`appendNote` 用换行追加，空行不写。
- 新增 `app/src/core/tasks.ts`
  - 导出 `TaskStatus`、`Task`、`TaskFilter`。
  - 薄封装 Store 方法，保持 SPEC 3.3 的函数名；`listTasks` 支持 `userId/status/dueBefore/limit`。
- `app/src/types.ts`
  - 加 `Task` 类型（字段与表一致；`files` 在 DB 是 JSON 字符串，TypeScript 层建议 `string[]`，读写时 JSON parse/stringify）。
- 新增 `app/src/ops/tasks.ts`
  - API 层校验/格式化：`listTasks`、`getTask`；把 `files` 转数组、`note` 限长（建议 8000 字）。
- `app/src/api.ts`
  - 只加 `case "tasks"`：`GET /v1/tasks?status=&limit=`、`GET /v1/tasks/:id`。
  - 不改现有 `pools/plans/memories/images/web/skills/sandbox` 分支。
- `app/src/ctl.ts`
  - 加 `ctl tasks [status]` 只读命令，方便本地验收。
- 新增 `app/test/tasks.test.ts`。

**新增表 / 接口**
- 表：`tasks`（SPEC 2.1 原样）。
- 接口：`GET /v1/tasks?status=&limit=`、`GET /v1/tasks/:id`。

**验收断言**
- 新库启动后 `tasks` 存在；旧库启动两次不报错（`CREATE TABLE IF NOT EXISTS` 幂等）。
- `createTask` 写入后 `getTask` 字段完整；`files` 能 JSON 往返。
- `listTasks({status:"pending"})` 只返回 pending；`dueBefore` 按 `start_at` 过滤。
- `appendNote` 追加一行，`updated_at` 变化；`cancelTask` 只改 `status='cancelled'`，不删除。
- `GET /v1/tasks` 无任务返回 `[]`；带错 status 返回 400；token 缺失 401。
- 现有 `npm test`、`npm run typecheck` 通过；唤醒日志、消息发送行为无变化。

**预计风险**
- `api.ts` 是另一个 Web 任务也会改的文件：两边都可能改 `switch` 和 `ApiDeps`。P0 只加 `case "tasks"`，不改 `ApiDeps` 形状；合入顺序建议 Web 任务先合或同一天合，避免大段冲突。
- SQLite 版本：`better-sqlite3` 支持 `RETURNING`，但 P0 不需要；P1 的 `claimNextTask` 用事务更稳。
- `status` 是自由字符串时要做白名单校验，别把非法值写进表。

---

### P1：WA runner（串行）+ 任务执行

**目标**
WA 用独立引擎、独立工具集、独立串行循环执行 `tasks`；完成/卡住/取消都写回面板；UFA 还不参与，但任务可以通过内部/API 创建。

**改动文件**
- 新增 `app/src/wa/runner.ts`
  - `startWa()` / `stopWa()`：`setInterval(2000)`（unref），`busy` 防重入。
  - `tick()`：`claimNextTask(now)` 取 `status='pending' AND start_at<=now`，按 `(start_at,id)` 升序；置 `running`；调 `waEngine.run()`；写回 `result/artifact/status/end_at`；触发 `ufa.enqueue({trigger:"task-updated", poolId})`（P2 接入；P1 可先留空钩子）。
  - 任务提示词：把 `goal/deliverable/constraints/acceptance/files/note` 拼成 WA prompt；要求最终文本符合 `## 结果 / ## 产物 / ## 卡点`，runner 解析这三段。
- `app/src/agent/tools.ts`
  - 把 `createTools()` 拆成 `createUfaTools(d)` / `createWaTools(d)`，或加 `profile: "ufa" | "wa"` 参数；保持现有调用方兼容（默认 `"chat"` 或 `"legacy"`）。
  - `createWaTools`：`terminal`、`read_file`、`write_file`（仅 docker；host 模式仍不注册）、`rb`、`web` 相关工具；**不注册 `chat`、`memory`、`plan`**。
  - `terminal` 的 `classify/approval` 逻辑原样保留（`tools.ts:440-461`），只从单 agent 挪到 WA profile。
  - `createUfaTools` 在 P2 再做；P1 先保留旧 `createTools` 给现有单 agent，避免双改。
- `app/src/agent/engine.ts`
  - `PiEngineDeps` 增加 `namespace?: "ufa" | "wa"`，`piDir/cwd/sessionDir` 用 namespace 子目录。
  - `RunLimits` 增加 `onToolEnd?: (info) => string | null`；在 `runPrompt()` 的 `tool_execution_end` 后调用，返回非空就 `abort()`（见 C9）。
  - `run()` 的 handoff 逻辑保持不变；WA 和 UFA 各自交接，不共享 `pendingHandoff`。
- `app/src/app.ts`
  - `waEngine = new PiEngine({... tools: createWaTools(...), systemPrompt: waSystemPrompt(...), namespace:"wa" })`。
  - `waRunner = new WaRunner({ store, engine: waEngine, log, onTaskUpdated })`；`start()` 启动，`stop()` 停止。
  - **不要**把 WA 放进现有 `RunQueue`。
- `app/src/core/tasks.ts` / `db.ts`
  - `claimNextTask` 用事务：`SELECT ... LIMIT 1` + `UPDATE ... WHERE id=? AND status='pending'`，防重复认领。
  - `updateTask` 允许 `status/note/result/artifact/end_at`；`result/artifact` 限长（建议 8000/2000 字）。
- `app/src/api.ts`
  - 加写路由：`POST /v1/tasks`、`POST /v1/tasks/:id/note`、`POST /v1/tasks/:id/cancel`、`POST /v1/tasks/:id/status`。
  - 复用 `ops/tasks.ts` 的校验；`POST /v1/tasks` 的 `start_at` 缺省为 `Date.now()`。
- `app/src/config.ts`
  - 增加 `wa: { pollMs: number; maxNoteChars: number }`（默认 2000/8000），并校验正数；不要动现有 `scheduler` 默认值。
- 新增 `app/test/wa-runner.test.ts`。

**新增表 / 接口**
- 无新表；复用 P0 `tasks`。
- 接口：`POST /v1/tasks`、`POST /v1/tasks/:id/note`、`POST /v1/tasks/:id/cancel`、`POST /v1/tasks/:id/status`。
- 内部：`startWa/stopWa`、`claimNextTask`、`RunLimits.onToolEnd`、`PiEngineDeps.namespace`。

**验收断言**
- A8：`start_at` 在未来的任务，WA 到点前不取。
- A9：到点后 WA 取走并置 `running`。
- A10：完成 → `status='done'`、`artifact` 非空、回调 `task-updated` 被触发（P1 可先断言回调被调用）。
- A11：WA 返回“卡点” → `status='blocked'`、`note` 非空。
- A12：`POST /:id/note` 追加后 `status` 回 `pending`，WA 下一轮重新取到。
- A13：`POST /:id/cancel` 后，WA 在当前工具调用结束后停，`note` 写明停在哪、有无半成品。
- A16：两个同 `start_at` 任务按 `id` 升序串行。
- WA 工具集里没有 `chat`；WA 的 assistant 文本不会直接发到聊天。
- `npm test`、`npm run typecheck` 通过；现有单 agent 行为不变（P1 默认仍走旧 `createTools`）。

**预计风险**
- 两个 `PiEngine` 共用 `dataDir` 会抢 session 文件：必须用 `namespace` 分目录；否则 `SessionManager.create/continueRecent` 会互相污染。
- `terminal` 审批是全局串行的（`ApprovalGate` 一次一条），WA 串行正好匹配；不要在这一阶段给 UFA 也接 `terminal`。
- WA 长任务的 `note/result` 可能无界增长：`maxNoteChars` 截断，并在 prompt 里只带最近 N 行。
- `onToolEnd` 的 abort 是软停止：不要在工具执行中途硬杀；`abortReason` 要写进 `note`。

---

### P2：UFA runner + 30 秒窗口

**目标**
消息进入后由 UFA 判断“完整/不完整”；不完整开 30s 窗口，窗口内只入队不重开；窗口到期一次性处理；UFA 可回话并登记任务；WA 回写任务后非打断唤醒 UFA。

**改动文件**
- 新增 `app/src/ufa/window.ts`
  - `DeferWindow`：`open(poolId, delayMs=30000)` 幂等（已有窗口直接返回，不刷新 timer）、`push`、`drain`、`flush`、`cancel`。
  - 内部 `Map<poolId, { timer, items, openedAt, dueAt }>`；`push` 只 push，不碰 timer。
  - `drain` 返回 `items` 并清空；为覆盖 B2，drain 时还应从 `store.messagesAfter(poolId, cursor)` 补一次，按 `seq` 去重。
- 新增 `app/src/ufa/runner.ts`
  - `UfaInput { poolId, userId, messages, trigger: "message"|"window-expired"|"task-updated" }`。
  - `runUfa()`：按 trigger 选 `ufa-scene-message/window/task`，调 `ufaEngine.run()`。
  - 读 `res.toolCalls`：`defer` → `window.open(poolId, ms)`；`create_task` → `createTask()`；`chat.send` 正常发；没 `defer` 也没 `chat.send` → 记日志并按 `defer(30000)` 兜底（或返回错误让她重来，二选一，建议兜底）。
- `app/src/core/hub.ts`
  - `ingest()` 在 `insertMessage` 成功后：
    - 若 `window.has(poolId)` → `window.push(saved)`，返回，不唤醒。
    - 否则把 `saved` 投递到 `UfaQueue`（替代 `scheduler.onMessage()` 的路径）。
  - 保留 `takeUnread()` 给旧链路/兼容；新链路用窗口里的消息，不再让 scheduler 抢游标。
- `app/src/core/queue.ts` 或新增 `app/src/ufa/queue.ts`
  - UFA 单并发队列，按 pool 保序；不要复用 `RunQueue` 的同类型合并（会破坏 B3/B4 的“逐条处理”）。
- `app/src/agent/tools.ts`
  - `createUfaTools`：`read_file`（500 字截断）、`write_file`（沙盒根，见 C3）、`create_task/get_task/list_tasks/cancel_task`、`search_messages`（结构化参数，见 C10）、`search_memories/write_memory`、`chat.send`（或 UFA 专用 `reply`）。
  - 不给 `terminal`、`web`、图片处理、`rb` 的写能力。
- `app/src/agent/prompt.ts`
  - 拆成 `ufaSystemPrompt()` / `waSystemPrompt()`，或保留 `systemPrompt()` 但按 profile 选模板；`wakePrompt()` 拆成 `ufaPrompt()` / `waTaskPrompt()`。
  - 模板文件：`app/data/sandbox/prompt/ufa-system.md`、`ufa-scene-message.md`、`ufa-scene-window.md`、`ufa-scene-task.md`、`wa-system.md`、`wa-scene-task.md`。
  - WA 模板无人格，从第一行就是效率；UFA 模板保留现有 `system.md` 的人格段落。
- `app/src/app.ts`
  - 新增 `ufaEngine`（namespace `"ufa"`）、`ufaQueue`、`window`；`start()` 启动，`stop()` 清 timer。
  - `proactive.enabled` 默认关掉；`startReflectionLoop()` 在 UFA 模式下不启动（保留代码，配置开关）。
  - `handleWake()` 只服务旧链路；新 UFA 不走 `handleWake()`。
- `app/src/config.ts`
  - 增加 `ufa: { windowMs: number; flushPatterns: string[] }`（默认 30000）。
- `app/src/api.ts`
  - 若 P1 没加 `POST /v1/tasks`，这里补；`GET /v1/tasks` 已存在。
- 新增 `app/test/ufa-window.test.ts`、`app/test/ufa-runner.test.ts`。

**新增表 / 接口**
- 无新表。
- 内部：`runUfa`、`DeferWindow`、`UfaInput`、`UfaQueue`、`createUfaTools`。
- 工具：`defer`、`create_task/get_task/list_tasks/cancel_task`、`search_messages`、`search_memories/write_memory`。
- API 复用 P1 的 tasks 写路由。

**验收断言**
- A1：单条完整消息 → UFA 立即回，窗口不打开。
- A2：UFA 返回 `defer` → 窗口开；`push` 后 `open()` 不重开 timer（A3）。
- A4：窗口到期 → 一次 `runUfa` 收到全部积压。
- A5：用户说“别等了”→ `flush()` 立即引爆。
- A6/B3：UFA 生成中收到消息 → 入队，生成完成后处理，不丢。
- A7：UFA 返回 `tasks` / 调 `create_task` → 库里多一条 `pending`。
- B1/B2/B4/B5/B6/B7/B8：逐条覆盖；B7 明确“窗口不持久化，重启按新消息处理”。
- 入口断言：`Hub.ingest()` 在 UFA 模式下不再调用 `Scheduler.onMessage()`；scheduler 不再因 `poolsWithUnread()` 唤醒 UFA。
- `npm test`、`npm run typecheck` 通过。

**预计风险**
- 消息顺序与游标：UFA 直接消费消息后，`cursors` 的推进要统一由 UFA 完成；否则旧 `poolsWithUnread()` 会重复唤醒。建议 P2 把 `poolsWithUnread()` 的 tick 路径关掉。
- B2 的同一时刻消息：drain 时补读 `messagesAfter`，按 `seq` 去重；不要只依赖内存数组。
- `write_file` 在 host 模式的路径边界：必须 `realpath` + 限制在 `cfg.exec.dir`，否则 UFA 变成第二个 shell。
- 提示词缓存/会话：UFA 和 WA 各自 `namespace`；`fresh-session` 文件现在是一个全局标记（`engine.ts:134-143`），两个引擎会同时消费。P2 要改成按 namespace 的标记（`run/fresh-session-ufa` / `-wa`），或让 ctl 指定 profile。

---

### P3：记忆时间维度收尾

**目标**
在不破坏现有 `memory-validity` 行为的前提下，补齐 SPEC 2.2 的查询契约和 plan 型记忆到期；不做自动 supersede。

**改动文件**
- `app/src/core/db.ts`
  - 如果决定加 `kind_ext`：`SCHEMA` + 旧库补列；否则不动。
  - `visibleMemories` 已经支持 `at/includeExpired`，只确认 `COALESCE(valid_from, created_at)` 口径；不要改成 `valid_from <= ?` 以免 NULL 旧数据查不到。
- `app/src/ops/memories.ts`
  - `SearchMemoryInput` 增加 `asOf?: string | number`，内部 `parseTs(input.asOf ?? input.at)`；保留 `at` 兼容。
  - `addMemory` 的 `kind='plan'`：如果传 `until`，写 `valid_to`；如果没有 `kind_ext`，不额外写列。
- `app/src/api.ts`
  - `GET /v1/memories` 增加 `asOf` 查询参数，和现有 `at` 等价；优先级 `asOf` > `at`。
- `app/src/agent/tools.ts`
  - `memory` 工具的参数描述增加 `asOf`（或明确 `at` 就是 asOf），返回格式继续带 `#id/from/to/replaced_by`。
- `app/src/agent/prompt.ts`
  - 记忆块只显示“此刻有效”的条目；如果要显示历史，必须显式 `asOf`，不要默认把失效条目塞进上下文。
- `app/test/memory-validity.test.ts`
  - 补 A14/A15 的断言：写 `valid_to` 后 `asOf=now` 查不到、`asOf=过去` 查得到；`supersede` 后旧条 `valid_to` 被填、`superseded_by` 指向新条。

**新增表 / 接口**
- 可能新增 `memories.kind_ext`（待拍板；建议不加）。
- 接口：`GET /v1/memories?asOf=`。

**验收断言**
- A14/A15 通过；现有 `memory-validity.test.ts` 全绿。
- 不传 `asOf` 时行为与现在完全一致（只看 `valid_to IS NULL`）。
- `kind='plan'` + `until` 到期后默认查不到；`at/asOf` 过去时间能查到。
- 没有自动 supersede：两条同 user/kind/fact 不会因为内容相似被自动关闭。

**预计风险**
- 旧数据 `valid_from=NULL`：查询已经用 `COALESCE`，不要做“全表回填”造成不必要的写放大；如果一定要回填，先记录 affected ids 到 `kv` 便于回滚。
- `asOf` 与 `at` 同时出现时优先级要写进 API 文档，避免控制台和沙盒脚本行为不一致。

---

### P4：删旧模型 / 迁移数据

**目标**
在 `tasks` 跑通一周后，停止写 `plans`，完成 `plans → tasks` 数据迁移，删除 `tide/energy/wave` 的运行时接线和旧测试，最后归档/删除旧表。

**改动文件**
- `app/src/core/db.ts`
  - 停止 `recordTideEvent`、`countTideFired`、`lastTideFired`、`silentWaveStreak` 的调用/导出；先保留方法一版，P4 末尾再删。
  - `tide_events` 改为归档表（建议 `ALTER TABLE tide_events RENAME TO tide_events_archived`），确认无读后再 `DROP`。
  - `plans`/`plan_fires` 先保留只读；迁移完成、确认无写入后再删。
- `app/src/core/plans.ts`
  - P4 删除；`localDay()` 先搬到 `app/src/core/time.ts`。
- `app/src/core/tide.ts`
  - P4 删除；`localDay` 的引用改到 `time.ts`。
- `app/src/core/idle.ts`
  - `localDay` import 改到 `time.ts`。
- `app/src/app.ts` / `app/src/core/scheduler.ts`
  - 移除 `PlanEngine`、`duePlans`、`proactivePools` 的接线；`Scheduler` 若只服务旧 plans，可整体停用/删除。
- `app/src/agent/prompt.ts`
  - 删除 `lastTideFired/countTideFired/localDay` 的状态块；UFA/WA 提示词不再提“上次主动/今天已主动”。
- `app/src/agent/tools.ts`
  - 删除 `plan` 工具；`create_task` 取代。
- `app/src/api.ts`
  - `/v1/plans` 标记 deprecated 只读；不删除路由（SPEC 0“API 只加不改”）。
- `app/src/ctl.ts`
  - `plans` 命令改为读只读/迁移报告；新增 `tasks` 命令。
- `app/src/sim.ts`
  - 演示从 `insertPlan` 改 `createTask`。
- `app/src/config.ts`
  - 删除 `tide`/`plans` 配置和校验；保留 `proactive` 开关（或一起休眠）。
- 测试：
  - 删除 `test/tide.test.ts`、`test/plans.test.ts` 中依赖 tide 的用例；保留 `plans → tasks` 迁移测试。
  - 更新 `wake-script.test.ts`、`pipeline.test.ts`、`scheduler.test.ts` 的旧 plan/wake 断言。

**新增表 / 接口**
- 无新表；`tasks` 接管。
- 迁移表/标记：`kv` 里的迁移标记（见第 5 节），不新增业务表。

**验收断言**
- A17：删掉 energy/tide/wave 后 `npx tsc --noEmit` 干净，无悬空 import。
- `rg "tide|energy|wave|PlanEngine|plans"` 在 `app/src` 只剩归档/迁移注释或明确的只读代码。
- 迁移后 `tasks` 数量 = 可迁移 `plans` 数量；不可迁移的（cron/global/none/expired）有迁移报告。
- `/v1/plans` 仍可读（若保留），但不再产生新计划；`/v1/tasks` 正常。
- `npm test`、`npm run typecheck` 全绿；`npm run demo` 不再依赖 plans。

**预计风险**
- 删除 `tide_events` 不可逆：必须先归档、备份、确认无读；不要在同一 commit 里既删表又删代码。
- cron 计划迁移会丢重复语义：如果还没决定，P4 只迁 `once`，cron 留在 `plans` 只读，不要猜。
- `ctl`/沙盒脚本可能还在调 `/v1/plans`：保留只读路由，先观察访问日志再删。
- 旧测试大量依赖 `Wake.planFires`：P4 前先让 `tasks` 测试独立，避免“删旧测试”掩盖回归。

---

## 5. 数据迁移

### 5.1 `plans → tasks` 字段映射

| `plans` 字段 | `tasks` 字段 | 规则 |
|---|---|---|
| `id` | — | 不复制；用 `kv` 记录 `migrate.tasks.v1.plan.<id> -> taskId` |
| `title` | `goal` | 直接用；空 title 的计划不迁移，报告出来 |
| `content` | `acceptance` | 原计划“到点要说的话”作为验收描述；为空则空串 |
| `why` | `constraints` | 前缀 `原计划理由：`；为空则空串 |
| `pool_id` | `pool_id` | 必须非空；`NULL` 不迁移（保留在 plans 只读），不要造假池 |
| — | `user_id` | `store.lastUserId(pool_id)`；取不到用 `u_migrated`，note 标明 |
| `schedule_kind='once'` + `schedule` | `start_at` | `Date.parse(schedule)`；`<= now` 按“立即”处理 |
| `schedule_kind='cron'` | — | 不迁 tasks；保留 plans 只读，等 recurrence SPEC |
| `schedule_kind='none'` | — | 不迁；无触发语义，保留 plans 或在报告中标记 skipped |
| `status='pending'` | `status='pending'` | 未来/现在到点的都 pending |
| `status='done'` | `status='done'` | `end_at = updated_at`；`result` 写 `迁移自 plans#<id>` |
| `status='cancelled'` | `status='cancelled'` | `end_at = updated_at` |
| `status='expired'` | `status='cancelled'` | `note` 写明“原计划已过期”；不要用 `failed` |
| `expires_at` | `note` | `expires_at <= now` 的 pending 计划直接迁成 `cancelled`；未来的写进 note |
| `created_at/updated_at` | 同名字段 | 原样复制 |
| — | `deliverable` | once 提醒类写 `到点发一条提醒`；其他空串 |
| — | `files` | `'[]'` |
| — | `note` | 固定前缀 `migrated:plans#<id>；` + 原 `why` + 过期/跳过原因 |
| — | `artifact` | 空串 |

**未触发计划**
- `pending + once + start_at > now`：正常迁 `pending`，WA 到点取。
- `pending + once + start_at <= now`：迁 `pending`，WA 下一轮立即取；如果 `now - start_at > 7 天`，迁 `cancelled` 并在 `note` 写“过期未触发，未自动补发”，避免隔很久突然执行。
- 已有 `plan_fires` 记录且该 `fire_ts` 已过的 once：说明触发过；不要迁成 `pending`，迁 `done`（或 `cancelled`，按原 status），防止重复执行。

**过期策略**
- `expires_at <= now`：不迁成可执行任务；迁 `cancelled`，`note` 保留原因。
- `expires_at > now`：迁 `pending`，`note` 写 `原过期时间：<ISO>`；`tasks` 不新增 `expires_at` 字段。
- 迁移脚本不做“自动补发”；补发是产品行为，必须单独决定。

**幂等**
- 整个迁移在 `store.db.transaction()` 里跑。
- 每条计划先查 `kv` 的 `migrate.tasks.v1.plan.<id>`：
  - 有值且对应 task 存在 → 跳过。
  - 有值但 task 不存在 → 重建并更新标记。
  - 无值 → 插入 task，写标记。
- 另外用 `note LIKE 'migrated:plans#<id>；%'` 做二次校验，防止 `kv` 丢失。
- 脚本末尾写 `migrate.tasks.v1.done = <ts>`；重复运行直接退出（除非 `--force`）。

**回滚**
- 迁移前备份：`cp app/data/rabbit-bot.db app/data/backup/rabbit-bot-<ts>.db`（或 `sqlite3 .backup`）。
- 回滚只删迁移出来的任务：`DELETE FROM tasks WHERE note LIKE 'migrated:plans#%'`；`plans` 原表未动，旧链路仍可用。
- 删除对应的 `kv` 标记；不要回滚 `plans`/`plan_fires`（它们没有被改）。
- 如果已经停写 plans，回滚代码即可恢复；数据层不需要反向迁移。

### 5.2 `memories` 补 `valid_from/valid_to`

**现状**
三列已经在 `db.ts` 的 `SCHEMA` 和旧库补列里；`visibleMemories` 用 `COALESCE(valid_from, created_at)`。因此“补列”这一步不需要再做。

**建议**
- **不做全表回填**：`valid_from=NULL` 的语义就是“从 `created_at` 开始”，查询已经兼容；回填只会制造写放大和回滚难度。
- 如果产品要求字段物理非空：只回填 `valid_from = created_at`，并记录 affected ids 到 `kv`（`migrate.memories.valid_from.v1`），回滚时按 id 置回 `NULL`。
- `valid_to` 不要批量填：现有 NULL 就是“至今有效”；只有明确关闭/被顶掉的条目才有值。
- `superseded_by` 不做自动推断：ARCH 4.3 明确“写入的人自己说”；历史数据里内容相近的条目不要自动配对。
- `kind='plan'` 的到期：
  - 如果已有 `valid_to`，不动。
  - 如果没有 `valid_to` 且能从内容里确定到期时间，不要猜；留空，等下一次写入时由调用方给 `until`。
  - 如果决定加 `kind_ext`，只给新写入的 plan 记忆填，历史数据留 NULL；不要根据自然语言解析日期。

### 5.3 迁移脚本的幂等与回滚

- **脚本位置**：建议 `app/src/ops/migrate-tasks.ts`（或 `app/scripts/migrate-tasks.ts`），只读 `Store`，不启动 adapter/API。
- **执行方式**：`npm run migrate:tasks -- --dry-run` 先打印报告；`--apply` 才写库；`--force` 才忽略 `migrate.tasks.v1.done`。
- **事务边界**：一个计划一条事务，或整批一个事务；整批更快，但失败时全回滚。建议整批事务 + 逐条报告，失败不留下半条。
- **锁**：迁移前必须确认主进程已停（`main.pid` 锁不在），避免 WAL 并发写；或只允许在 `paused` 状态下跑。
- **回滚点**：备份文件 + `kv` 标记 + `tasks.note` 前缀，三者任二可定位迁移数据。
- **不删旧数据**：P4 前不 `DROP`、不 `DELETE plans`；迁移只是“复制并标记”，旧链路可随时接管。

---

## 6. 与 Web 控制台的分工

另一个任务正在做本地 Web 控制台：静态页 + `GET /` + `POST /v1/pools/:ref/messages`，并给 `ApiDeps` 加 `hub`。本计划的边界如下。

### 6.1 控制台先展示什么

P0 完成即可展示：

- 任务列表：`GET /v1/tasks?status=&limit=`，列 `goal/status/pool_id/start_at/updated_at/note/result/artifact`。
- 任务详情：`GET /v1/tasks/:id`，显示完整 `note`、`files`、`created_at/updated_at/end_at`。
- 状态筛选：`pending/running/blocked/done/failed/cancelled`。
- 自动刷新：沿用控制台现有的 3 秒轮询；不需要 websocket。
- 只读，不提供“新建/取消/改状态”按钮；这些等 P1 的写接口稳定后再加。

### 6.2 后端还需要哪些接口

P0：`GET /v1/tasks`、`GET /v1/tasks/:id`。
P1：`POST /v1/tasks`、`POST /v1/tasks/:id/note`、`POST /v1/tasks/:id/cancel`、`POST /v1/tasks/:id/status`。
P3：`GET /v1/memories?asOf=`（控制台若要“按时间看记忆”再用）。

所有接口沿用 `{ok,data}` / `{ok,false,error}` 和 Bearer token；控制台不要把 token 写进 URL。

### 6.3 避免两边重复造

- 任务模型只在 `app/src/core/tasks.ts` + `app/src/core/db.ts`；控制台只消费 JSON，不复制状态机、不直接读 SQLite。
- 控制台的 `POST /v1/pools/:ref/messages` 走 `Hub.ingest()`；P2 后它会自然触发 UFA。P2 前它只入池，现有单 agent 可能被 scheduler 唤醒，控制台文档要写清“改造期间的行为”。
- `api.ts` 的合并顺序：
  1. 先合 Web 任务的静态页 + `POST /v1/pools/:ref/messages` + `ApiDeps.hub`；
  2. 再合本计划的 `case "tasks"`；
  3. 两边都只加分支，不改现有 `pools/plans/memories/...` 的 401/404 语义。
- 如果控制台坚持在 P0 前做任务页，只能做空壳 + 错误提示；不要先建第二张 `tasks` 表。

---

## 7. 待拍板问题（5 条）

1. **WA 是否复用现有 PiEngine？**
   建议：复用。两个 `PiEngine` 实例（namespace `ufa`/`wa`），不引入 opencode 或第二套框架。需要确认的是“是否接受两个实例各自维护 session/handoff”。

2. **WA 任务并发度是否保持 1？**
   建议：保持 1。SPEC 0/3.4 已定串行；并发 >1 会引入任务抢占、审批串行、同一池消息顺序等问题。需要确认“长任务堵住后续任务”可接受。

3. **UFA 是否保留人格？**
   建议：保留。ARCH 职责表明确 UFA 人格是核心；WA 无人格。需要确认“UFA 人格是否继续从 `persona.md` 读取”，还是改成 `ufa-system.md` 内置。

4. **任务面板是否对外？**
   建议：只对本机/受信网络 + Bearer token 开放，不做公网。需要确认控制台是否允许局域网访问（现有 API 默认 `0.0.0.0`，风险不同）。

5. **cron/重复计划怎么处理？**
   建议：P4 只迁 `once`；cron 继续留在 `plans` 只读，等单独的 recurrence SPEC。需要确认“任务面板是否必须支持重复任务”，如果必须，就要在 `tasks` 加字段，和 SPEC 2.1“不加更多字段”冲突。

---

## 8. 风险与回滚

### 8.1 单实例锁

- 现状：`main.ts:45` 用 `acquireLock(data/run/main.pid)`，`lockfile.ts` 用 pid + 启动时间防 pid 复用。
- 风险：如果为了 WA 另起一个进程，会绕过这把锁，两个进程同时写 `tasks`、同时消费审批序号、同时跑 scheduler。
- 要求：UFA 和 WA 在同一个进程内；如果必须拆进程，先扩展锁为“主进程 + worker 角色”并给 worker 单独的锁文件，不要直接复制 `main.ts`。
- 回滚：停 WA runner 即可，UFA 和旧链路不受影响；`tasks` 表保留。

### 8.2 唤醒队列

- 风险：UFA 消息、WA 任务、旧 `plan/proactive` 三种事件混在一个队列，WA 长任务会阻塞 UFA；同类型合并会吞掉“逐条消息”的语义。
- 要求：UFA 独立队列（按 pool 保序、单并发）；WA 独立 2s 循环（单并发）；旧 `RunQueue` 只做过渡。
- 有界队列：UFA 队列按 pool 合并“待处理消息”，不要无限堆；WA 任务本身在 SQLite，队列只放“已认领任务”。
- 回滚：把 `Hub.ingest()` 切回 `scheduler.onMessage()`，UFA 队列停止消费；旧链路立即可用。

### 8.3 消息去重

- 现状：`messages` 有 `UNIQUE(platform,msg_id)`，`insertMessage()` 重复返回 `null`（`db.ts:188-199`）。
- 要求：UFA 窗口只接收 `insertMessage()` 返回的 `StoredMessage`，不要用 adapter 原始消息；Web/inject 的 `msg_id` 必须唯一（现有 `inject-<uuid>` 已满足）。
- 30s 窗口重启会丢：ARCH B7 已接受“不持久化，重启按普通新消息处理”；不要为了窗口持久化再建一张表。
- 任务认领用事务 + `status='pending'` 条件，防两个 WA 实例重复执行；P1 只有一个实例，但仍要写对。

### 8.4 内存 / 上下文上限

- UFA：`read_file` 500 字截断；消息时间线只给最近 N 条 + 时间戳；`search_messages` 限 `limit`；不要把整池历史塞进 prompt。
- WA：任务 prompt 只带 `goal/deliverable/constraints/acceptance/files/note` 和必要上下文；`note` 限长（建议 8000 字）；工具输出超限走现有 `overflowFile`（`shell-runner.ts:92-103`）。
- 两个引擎各自 handoff：`contextTokenLimit`/`sessionTokenLimit` 是全局配置；如果 UFA 和 WA 上下文差异大，后续可拆 `ufa.*`/`wa.*` 配置，但 P2 先复用。
- 回滚：上下文爆炸时先降 `context.recentContextMessages`、`maxUnreadPerPool`，或暂停 WA；不要直接清库。

### 8.5 审批链路

- 现状：`ApprovalGate` 一次只允许一条待审（`approval.ts:64,99-105`），超时 fail-closed（`:107-131`），裁决/执行完回审批房（`:145-165`），日志 `data/approval.jsonl`（`app.ts:96`）。
- 要求：只把 `terminal` 接到 WA；UFA 不注册 `terminal`，避免 UFA 聊天时触发审批、也避免审批房内容进 UFA 上下文（`hub.ts:53` 会吞掉审批房消息）。
- host 模式：`approval.enabled=false` 时 `terminal` 对 `ask` 档直接拒绝（`tools.ts:450-453`），这是现有的 fail-closed；不要新增“关掉审批就放行”的配置。
- `exec.shell.safeProgs` 是免审白名单（`config/default.json` + `cmd-rules.ts`），只放确认无副作用的程序；WA 不要自己改这个名单。
- 回滚：把 `exec.shell.mode` 改回 `docker`，或把 WA 的 `terminal` 从工具集移除；审批日志保留，不影响回滚。

### 8.6 各阶段回滚

- P0：停用 `/v1/tasks` 路由，删 `tasks` 表即可；`plans` 未动。
- P1：停 WA runner，任务表保留；UFA/旧链路不受影响。
- P2：`Hub.ingest()` 切回 `scheduler.onMessage()`，UFA 队列停；窗口内存丢失可接受。
- P3：`asOf` 是别名，回滚只需不传；`kind_ext` 若加了，保留列不影响旧查询。
- P4：只做归档/只读，不立即 `DROP`；回滚用备份库 + git revert，不反向迁移数据。

---

## 9. 验收断言对照

| 断言 | 阶段 | 验收点 |
|---|---|---|
| A1 单条完整消息立即回 | P2 | `runUfa` 不产生 defer，`chat.send` 被调用 |
| A2 不完整消息开窗口 | P2 | `DeferWindow.has(pool)` 为真 |
| A3 窗口内不重开 timer | P2 | `open()` 幂等，`dueAt` 不变 |
| A4 到期一次收到全部 | P2 | `drain()` 返回 N 条，只调一次 `runUfa` |
| A5 “别等了”提前引爆 | P2 | `flush()` 返回积压，timer 清理 |
| A6 生成中消息入队 | P2 | UFA 队列不丢消息，生成后处理 |
| A7 带 tasks 入库 | P2 | `tasks` 多一条 `pending` |
| A8 未来任务不取 | P1 | `claimNextTask` 不返回 |
| A9 到点取走 | P1 | `status='running'` |
| A10 完成回写 | P1 | `done` + `artifact` 非空 + `task-updated` |
| A11 卡点回写 | P1 | `blocked` + `note` 非空 |
| A12 答完回 pending | P1 | `appendNote` + `status='pending'`，WA 再取 |
| A13 取消软停 | P1 | `onToolEnd` 命中 `cancelled`，`note` 写明停点 |
| A14 记忆 `valid_to` | P3 | `asOf=now` 查不到，`asOf=过去` 查得到 |
| A15 supersede | P3 | 旧条 `valid_to` + `superseded_by` 正确 |
| A16 同 start_at 串行 | P1 | 按 `id` 升序，串行执行 |
| A17 删旧模型后编译干净 | P4 | `tsc --noEmit` 无悬空 import |

---

## 附录：本文核对过的文件

- `docs/ARCH-UFA-WA.md`
- `docs/SPEC-UFA-WA.md`
- `docs/SPEC-host-shell-approval.md`
- `app/src/agent/engine.ts`
- `app/src/agent/prompt.ts`
- `app/src/agent/tools.ts`
- `app/src/agent/template.ts`
- `app/src/agent/persona.ts`
- `app/src/core/db.ts`
- `app/src/core/plans.ts`
- `app/src/core/tide.ts`
- `app/src/core/gate.ts`
- `app/src/core/reflection.ts`
- `app/src/core/scheduler.ts`
- `app/src/core/queue.ts`
- `app/src/core/hub.ts`
- `app/src/core/approval.ts`
- `app/src/core/shell-runner.ts`
- `app/src/core/lockfile.ts`
- `app/src/core/time.ts`
- `app/src/ops/exec.ts`
- `app/src/ops/memories.ts`
- `app/src/ops/plans.ts`
- `app/src/api.ts`
- `app/src/app.ts`
- `app/src/main.ts`
- `app/src/ctl.ts`
- `app/src/sim.ts`
- `app/src/config.ts`
- `app/src/types.ts`
- `app/config/default.json`
- `app/data/sandbox/prompt/system.md`
- `app/data/sandbox/prompt/wake.md`
- `app/data/sandbox/prompt/scene-message.md`
- `app/test/memory-validity.test.ts`
- `.scratch/ufa-task-web-ui.md`
- `.scratch/ufa-task-ufa-wa-plan.md`
