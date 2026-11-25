# 任务控制与审计（/log、/resume、/interrupt、/stop）：详细方案

> 2026-11-25。已实现：`core/runner-tail.ts`、`core/task-audit.ts`、`core/task-controls.ts`、`sweepStuckTasks`；静默阈值配置见 `scheduler.stuckWarnMs`。
>
> 目标：任务卡住时，bot 能自己拿到执行器会话的实时进展，写进任务群；续跑、停止用确定性动作完成，并留下可审计记录。
>
> 关键约束：
>
> - **原有工具保留，不为了审计改工具集。** `task`、`memory`、`map` 等工具照旧注册、照旧调用。
> - **工具调用时顺带往对应任务池写一条 `/...` 审计指令**，`internal=true`、`notify=false`：审计面板可见，但不计入未读、不进 UFA 上下文、不触发唤醒。
> - **命令由 bot 发送，不面向用户**。用户不需要知道 `/log` 这些语法，也不需要新的前端入口；任务群里看到的是 bot 转述的人话。
> - 主要目的是**提高 task 操作的可追溯性、方便审计**，不是减少常驻工具数量。

---

## 0. 结论先行

1. **能做，而且不需要新造数据源。** 每条任务已经有 `session_id`，执行器的 stdout/stderr 已经逐行落在 `data/tasks/<id>/runner.jsonl`；opencode 的真实日志里能读到 `text`（助手说话）、`tool_use`（工具名/参数/输出/状态）、`step_start` / `step_finish`，足够回答“最后在干什么”。
2. **工具集不动，审计靠工具调用的副作用。** 原有 `task` 等工具保留；每次改任务（create/update/resume/interrupt/stop/note/status/retry/cancel）都往 `task:<id>` 池写一条 `/...` 审计指令，标 `internal`，不计未读。不做 IM 拦截、不做 Web 输入框、不需要权限校验和帮助文案。
3. **`/resume` 和 `/interrupt` 需要补一个参数。** 现在 `resumeTask` 的启动 prompt 写死为「继续任务，先读任务文档」，要把补充要求拼进去，同时写进任务事件，审计时才看得到“谁要求续跑、要求了什么”。
   - `/resume`：任务已经跑过、现在停着（`pending` / 卡住 / 失败后），用同一 session 续跑。
   - `/interrupt`：只给正在跑的任务用，先停再用同一 session 带新要求续跑。
   - **运行前（`pending_approval` / 还没启动）不改需求走命令，直接改任务字段**：复用审批时的字段补丁（`name/goal/deliverable/constraints/acceptance/files/work_dir/executor/model/eta`）并重写任务文档。`/interrupt` 在非 running 状态一律拒绝，不退化成别的动作。
4. **卡住要主动上报，不只靠人问。** 在现有执行器巡检里加一条“静默超时”判断：进程还活着、但 runner 日志超过阈值没有新事件，就自动抓一次摘要写进任务池，让下一轮 UFA tick 读到并转述。
5. **默认只保证 opencode / mimo。** codex / claude 的事件格式不同，先做兜底摘要，不承诺能还原完整对话。

---

## 1. 问题与约束

### 1.1 现在卡在哪

- 任务卡住时，UFA 只能看到任务池里的“已持续 N 分钟，可能有异常”，不知道执行器最后一步做了什么。
- 任务池是虚拟池（`platform=task`、`external_chat_id=task:<id>`），人无法在 IM 里直接往里打字；因此不能把命令入口做成“群里发斜杠命令”。
- `task` 工具已有 `resume` / `cancel` / `note`，但 `resume` 只带固定 prompt，无法把“按这个方向继续”传进去。
- 执行器是一次性进程，没有 stdin 通道；想给正在跑的任务追加要求，只能“停掉 + 同一 session 续跑”，这会丢掉当前半个步骤，需要在方案里明确。
- 执行器输出里可能含密钥、数据库密码、base64 图片；摘要必须脱敏、截断，不能原样贴回群里。

### 1.2 非目标

- 不做面向用户的管理命令、不写 `/help` 给用户看。
- 不改 Web 任务抽屉的交互，不加命令输入框。
- 不做“所有命令都能在 IM 群里发”的通用斜杠命令框架。
- 不把任务池里的审计指令当命令再执行一遍；动作只由工具/API 触发。
- 不为了审计减少或替换常驻工具。
- 不把完整 `runner.jsonl` 或整段工具输出塞进上下文。

---

## 2. 现状盘点（代码级）

| 能力 | 现在 | 位置 |
| --- | --- | --- |
| 任务会话 | `tasks.session_id`，恢复时用 `--session` / `-s` 沿用 | `app/src/core/tasks.ts`、`app/src/core/dispatch.ts` |
| 执行器实时日志 | 每条任务一个 `data/tasks/<id>/runner.jsonl`，追加写 | `runnerLogPath`：`app/src/core/task-usage.ts:32` |
| 日志已有解析 | 只解析用量（`step_finish` / `result` / `turn.completed`） | `parseRunnerUsage`：`app/src/core/task-usage.ts:37` |
| 任务事件 | `appendTaskEvent` 写任务池，可标 `internal`、可控制 `notify` | `app/src/core/task-events.ts:47` |
| 恢复执行 | `resumeTask`，prompt 固定 | `app/src/core/dispatch.ts:1172`，prompt 在 `:1031` |
| 停止执行 | `stopTask`，SIGTERM→SIGKILL，任务回到 `pending` | `app/src/core/dispatch.ts:1182` |
| 长任务提醒 | 超过 `eta_ms` 写一条提醒，每次执行只提醒一次 | `sweepLongRunningTasks`：`app/src/core/dispatch.ts:787` |
| 巡检挂载点 | `App.sweepRunners()` 先扫死亡进程，再扫长任务 | `app/src/app.ts:404` 附近 |
| Agent 工具 | `task resume / cancel / note / status` 已存在 | `app/src/agent/tools.ts:1006` 起 |
| HTTP API | `/v1/tasks/:id/{events,resume,stop}` 已存在 | `app/src/api.ts:615/733/746` |
| 操作审计 | 没有统一的“谁在什么时候对任务做了什么”记录；只有零散的 note / 事件 | 本次要补 |

### 2.1 opencode 真实日志长什么样

以本机 `app/data/tasks/307/runner.jsonl` 为例（607 行）：

```
tool_use   219
step_start 192
step_finish 192
text         2
ufa-dispatch 2
```

结论：

- opencode 主要靠 `tool_use` 暴露“在干什么”，`text` 只在关键节点出现；只取“最后几条助手文本”会几乎为空。
- `tool_use` 的 `part.state` 带 `status`、`input`、`output`，`input` 里可能有命令、路径、数据库密码，`output` 里可能有 base64 附件。
- 摘要必须以 `tool_use` 为主、`text` 为辅，并统一脱敏、截断。

---

## 3. 设计

### 3.1 总体流程

```
执行器(opencode/mimo/codex/claude)
  └─ stdout/stderr ──> runner.jsonl ──> runner-tail 解析 ──> 任务摘要

task 工具 / HTTP API 改任务
  ├─ 执行动作（读日志 / 改字段+重写文档 / resumeTask / stopTask / stop→resume）
  ├─ appendTaskAudit：往 task:<id> 写一条 /... 指令事件（internal，仅留痕）
  └─ 写结果事件（按场景 internal / notify）
        ├─ bot 主动调用：结果同步返回给 bot，事件仅留痕
        └─ 卡住自动上报：结果作为普通事件，唤醒 UFA 转述
```

要点：

- **动作由工具/API 真正执行，审计指令只是记录。** 不存在“先写 `/resume`、再由监听器解析执行”的第二条路径，避免重复恢复、重复停进程。
- UFA 不需要知道命令协议：它调用的是 `task action=log` 这种工具动作；`/log` 文本只是任务池里的审计记录。用户看到的是 UFA 用 `chat send` 发的人话。
- 之前的“常驻工具瘦身”方案不采用；见第 8 节。

### 3.2 任务池审计指令（只留痕，不驱动执行）

指令是任务池里的一种**内部控制行**，沿用斜杠前缀只为日志可读。它和普通任务事件写进同一张 `messages` 表，但 `internal=1`：

- `store.unread()` 和 `recentMessages()` 会过滤 `internal=1`，所以**不计入未读、不进 UFA 上下文**；
- `listTaskEvents()` 不过滤 `internal`，审计面板和 `/events` 接口仍能看到；
- `notify=false`，不触发任务 tick、不唤醒 UFA；
- **没有任何监听器会解析并执行这些行**，它们只是审计记录。

| 指令 | 由什么动作产生 | 记录内容 |
| --- | --- | --- |
| `/create #id …` | `task create` / `POST /v1/tasks` | 目标、work_dir、executor、创建者 |
| `/update #id …` | `task update` / 审批字段补丁 | 改了哪些字段（旧值→新值，敏感字段脱敏） |
| `/log #id lines=8` | `task log` | 谁在什么时候看了日志 |
| `/resume #id "…"` | `task resume` / `POST /v1/tasks/:id/resume` | 补充要求 |
| `/interrupt #id "…"` | `task interrupt` | 补充要求、停掉的 pid |
| `/stop #id` | `task stop` / `POST /v1/tasks/:id/stop` | 停掉的 pid、原状态 |
| `/cancel #id` | `task cancel` / `POST /v1/tasks/:id/cancel` | 取消原因 |
| `/retry #id` | `task retry` / `POST /v1/tasks/:id/retry` | 轮次 |
| `/note #id "…"` | `task note` / `POST /v1/tasks/:id/note` | 追加的说明 |
| `/status #id <status>` | `task status` / `POST /v1/tasks/:id/status` | 新状态、result/artifact 摘要 |

写入约定：

- 目标池固定是任务自己的 `task_pool_id`（`platform=task`、`external_chat_id=task:<id>`）；不往任务发起的真实群发，避免暴露内部语法。
- `sender="bot"`、`senderName=agent 名称`，`internal=true`，`notify=false`。`internal` 已经让 `unread()` 和上下文都跳过它，不需要再依赖 `from_self`。
- 只审计**写操作和控制操作**；`list` / `get` / `updates` 这类只读动作默认不写，避免刷屏。
- 指令里的参数统一脱敏、截断（和 runner 摘要同一套规则）；`instruction` 原样保留但限长。
- 审计写入失败不能影响主操作：`appendTaskAudit` 内部 `try/catch`，失败只记日志。

### 3.3 runner-tail：日志摘要

新增 `app/src/core/runner-tail.ts`，不改 `task-usage.ts` 的计费逻辑。

```ts
interface RunnerDigest {
  taskId: number;
  executor: string;
  sessionId: string;
  attempt: number;
  lastEventAt: number | null;
  silentMs: number;
  stuck: boolean;
  lastText: string | null;
  lastTool: {
    name: string;
    status: string;
    input: string;   // 脱敏+截断
    output: string;  // 脱敏+截断
    at: number;
  } | null;
  recent: Array<{
    at: number;
    kind: "text" | "tool";
    text: string;
  }>;
  truncated: boolean;
}
```

读取策略：

1. 只读文件尾部，默认最多 512KB（`tailBytes` 可配），避免大日志整读。
2. 只取当前这一轮：用 `task.runner_started_at` 过滤事件时间（留 5s 容差），避免恢复后混入上一轮。
3. 按行 `JSON.parse`，解析失败的行跳过。

opencode / mimo 提取：

- `type === "text"`：取 `part.text`，作为助手文本。
- `type === "tool_use"`：取 `part.tool` 作为工具名；`part.state.status` 作为状态；`part.state.input` 按工具类型生成摘要：
  - `bash`：`command`
  - `read` / `write` / `edit`：`filePath`
  - `grep` / `glob`：`pattern`
  - 其它：`JSON.stringify(input)` 前 200 字符
- `output`：取前 3 行 + 末 3 行，单行截断 160 字符；忽略 `attachments`、`metadata`、`preview`。
- `step_start` / `step_finish` 只用来推进 `lastEventAt`，不进摘要。

codex / claude 兜底：

- `claude`：`assistant.message.content` 里的文本、`tool_use` 块；`result` 作为结尾。
- `codex`：`item` / `turn.completed` 能取多少取多少；取不到时返回“该执行器暂不支持日志摘要，只能看进程是否存活”。

脱敏规则（摘要生成前统一执行）：

- 命中 `token`、`password`、`passwd`、`secret`、`api_key`、`authorization`、`Bearer`、`mysql -p`、`-p<...>` 等模式的值替换成 `***`。
- 去掉 `data:image/...;base64,...`、超长连续 base64、URL 里的 query token。
- 总输出硬上限默认 1500 字符（`maxChars` 可配），超出按“最近优先”截断，并在末尾标“（已截断）”。

摘要示例（最终写进任务池的形态）：

```
任务 #307 最近活动（opencode，session ses_df85…，静默 2 分 13 秒）
- 17:40:13 工具 bash：跑 go test ./service/rs/
- 17:40:12 工具 read：看 server/service/rs/shop.go
- 17:42:30 助手：正在核对 data_scope=4 的读路径
最近一次工具输出：ok  github.com/.../service/rs  0.761s
```

### 3.4 `/resume "具体要求"`

现有 `launch()` 的 prompt：

```ts
const prompt = opts.resume ? `继续任务，先读 ${docPath}` : `读 ${docPath} 并执行`;
```

改为：

```ts
const prompt = opts.resume
  ? [`继续任务，先读 ${docPath}`, opts.instruction ? `本次补充要求：\n${opts.instruction}` : ""]
      .filter(Boolean).join("\n\n")
  : `读 ${docPath} 并执行`;
```

配套改动：

- `LaunchOptions` 增加 `instruction?: string`。
- `resumeTask(store, task, deps, opts?: { instruction?: string })` 透传。
- 调用时往任务池写：
  - 审计指令：`/resume #id "具体要求"`（`internal=true`、`notify=false`，不计未读）
  - 结果事件：`续跑要求：具体要求`（普通事件，供 UFA 转述和面板读）
- 同时 `appendNote`，保证任务详情里也能看到。
- 审计指令不驱动执行；`resumeTask` 由工具/API 直接调用，避免写一条 `/resume` 再被解析一遍。
- 约束：
  - 只有 `session_id` 非空、进程不在跑时才能 resume；
  - 只对 opencode / mimo 保证语义一致；codex / claude 有各自的 resume 参数，按现有 `executorArgs` 分支处理，失败照常抛错；
  - 补充要求不写进任务文档，只进本轮 prompt，避免文档膨胀。

### 3.5 `/interrupt "具体要求"`：运行中追加要求

`/resume` 和 `/interrupt` 共用同一套 `instruction` 管道，但适用状态严格分开：

| | `/resume` | `/interrupt` |
| --- | --- | --- |
| 适用状态 | 跑过、现在停着（`pending` / 卡住 / 失败） | **只限 `running`** |
| 遇到在跑 | 拒绝 | 先停再续 |
| 遇到没在跑 | 直接续 | **拒绝**：运行前直接改任务字段，不要用 interrupt |
| 目的 | 继续做 | 运行中改方向 / 补要求 |

执行流程（同一个 `task action=interrupt`，工具/API 直接执行，审计只留痕）：

1. 查任务，必须存在、`status === "running"`、`runnerAlive` 为真、`session_id` 非空。任一不满足就拒绝：
   - 没在跑：`任务 #N 没在运行；未启动的任务直接改需求，已停止的任务用 /resume。`
   - 没 session：`任务 #N 没有会话，无法在同一上下文里追加要求。`
2. 每个任务一把进程内互斥锁（`taskId → transitioning`），`interrupt` / `resume` / `stop` 互斥，避免连续动作把进程停两次。
3. 写审计指令 `/interrupt #id "具体要求"`（`internal=true`、`notify=false`，不计未读）。
4. 写说明事件 `中断续跑要求：具体要求`（普通事件），并 `appendNote`。
5. `stopTask`：SIGTERM → `graceMs`（默认 5s）→ SIGKILL；等进程确实不在。
6. `resumeTask(..., { instruction })`：同一 session 续跑，进入新 attempt。
7. 写结果事件：`已中断 pid=...，按新要求恢复（attempt=N）`。

**运行前改需求不走 `/interrupt`**：

- `pending_approval`：复用审批接口的字段补丁（`name/goal/deliverable/constraints/acceptance/files/work_dir/executor/model/eta`），改完重写任务文档；Web 审批弹窗已经在做这件事。
- `pending`（已批准、等 `start_at` 或刚被 stop）：补一个 `task action=update`，字段白名单和审批接口一致，只改任务文档和 DB，不碰进程；还没 session 的任务也不需要 session。
- 这样 `/interrupt` 保持一个清晰语义：**只在有进程、有上下文、需要换方向时用**。

约束与取舍：

- **中断点不可控**：执行器是一问一答的一次性进程，没有 stdin 通道，只能杀掉再续。SIGTERM 时正在执行的工具可能留下半成品，恢复后由模型自己核对；这一点要在结果事件里写明。
- `/interrupt` 不是“实时插话”，是“停下、带着新要求重开同一会话”。不要承诺不丢当前步骤。
- 补充要求有长度上限（默认 2000 字符），超出拒绝并写内部错误事件，避免 prompt 被塞爆。
- 与 `/resume` 一样，只保证 opencode / mimo；codex / claude 按各自的 resume 分支处理，失败照常报错。

### 3.6 卡住自动上报

不新增定时器，挂在现有 `App.sweepRunners()` 里，和长任务提醒并列。

新增 `sweepStuckTasks(store, { now, stuckMs, dataDir })`：

- 取 `status='running'` 且 `runner_pid` 非空的任务。
- `runnerAlive` 为真才判断。
- 用 `runner-tail` 取 `lastEventAt`：
  - 没有事件：以 `runner_started_at` 为基准；
  - 有事件：以 `lastEventAt` 为基准。
- 静默超过 `stuckMs`（默认 5 分钟，配置 `scheduler.stuckWarnMs`）就生成摘要。
- 每条任务每轮执行只报一次：新增 `tasks.stuck_notified_at`（nullable），启动 / 恢复时清空；或用“最后一条任务事件已经是 `/log` 结果”兜底。
- 写入任务池：普通事件（非 internal）、`notify: true`，让任务 tick 唤醒 UFA 转述。
- 同时写一条 `internal` 审计指令 `/log #id (auto-stuck)`，`notify=false`，说明这次摘要是静默巡检触发的，方便回放。
- 摘要里必须包含：最后活动时间、静默时长、最后工具、最后助手文本。没有文本时明确写“本轮没有助手文本，只有工具调用”。

与现有 `sweepLongRunningTasks` 的关系：

- 长任务提醒保留，负责“超过预估耗时”；
- 静默提醒负责“进程还活着但没动静”；
- 两者都只报一次，互不替代。若同一轮同时命中，优先静默摘要，避免两条重复。

### 3.7 审计与上下文隔离

**工具保留，审计是副作用。** 不改 `createTools()` 的常驻工具清单，也不为了审计把工具改成文本命令；`task` 工具继续是结构化调用，只是在执行成功/失败后多写一条审计指令。

审计事件字段：

| 字段 | 值 |
| --- | --- |
| pool | 任务的 `task_pool_id`（`platform=task`、`external_chat_id=task:<id>`） |
| text | 规范化指令，如 `/resume #307 "先补只读准入测试"` |
| sender / senderName | `bot` / UFA 名称 |
| internal | `true`：`unread()`、`recentMessages()` 过滤，不计未读、不进上下文 |
| notify | `false`：不触发任务 tick、不唤醒 UFA |
| meta | `{ kind: "task_command", source: "tool" \| "api" \| "dispatcher", action, args, ok, result?, audit_only: true }` |

可见性与写入：

- 审计面板、`GET /v1/tasks/:id/events`、`listTaskEvents()` 能看到（它们不过滤 `internal`）。
- 真实 IM 群收不到，避免暴露内部语法。
- 写失败只记日志，不影响任务动作本身。
- `meta.audit_only=true` 明确标记“这条只用于审计”，杜绝以后误加监听器重复执行。

其他事件的口径不变：

- bot 主动调用 `task action=log/resume/interrupt/stop`：结果同步返回给工具调用方；结果事件默认 `internal=true`，避免 UFA 下一轮又读一遍自己刚看过的日志。
- 卡住自动上报：结果事件 `internal=false`、`notify=true`，UFA 必须读到并决定要不要转述。
- 所有审计指令都带时间、发起者、任务 id，便于按任务回放。`update` 的审计记录里旧值/新值都要有，敏感字段脱敏。

---

## 4. 改动清单

### 4.1 新增

| 文件 | 内容 |
| --- | --- |
| `app/src/core/runner-tail.ts` | 尾部读取、事件提取、脱敏、摘要生成 |
| `app/src/core/task-audit.ts` | 规范化 `/...` 指令文本、写 `internal` 审计事件、参数脱敏、`meta.audit_only` |
| `app/src/core/task-controls.ts` | `log` / `update` / `resume` / `interrupt` / `stop` 的执行逻辑、每任务互斥锁 |
| `app/test/runner-tail.test.ts` | opencode / claude 事件夹具、脱敏、截断、轮次过滤 |
| `app/test/task-audit.test.ts` | 指令格式、`internal`/`notify` 口径、不计未读、各动作都能落审计 |

### 4.2 修改

| 文件 | 改动 |
| --- | --- |
| `app/src/core/dispatch.ts` | `LaunchOptions.instruction`；`resumeTask` 透传；prompt 拼接；新增 `sweepStuckTasks`；`startTask` / `resumeTask` / `stopTask` 可选接受 `actor` 用于审计 |
| `app/src/core/task-events.ts` | `AppendTaskEventInput` 增加 `meta`；`TaskEvent` 返回 `meta`（给审计面板/接口） |
| `app/src/core/tasks.ts` | 可选新增 `stuck_notified_at` 字段与 update 白名单 |
| `app/src/core/db.ts` | 可选 `ALTER TABLE tasks ADD COLUMN stuck_notified_at INTEGER` |
| `app/src/agent/tools.ts` | `task` 新增 `action=log`、`action=interrupt`、`action=stop`、`action=update`（运行前改需求）；`action=resume` / `interrupt` 增加 `instruction`；**所有写操作调用 `task-audit` 落审计**；工具清单不变 |
| `app/src/api.ts` | 审批/拒绝/start/resume/stop/cancel/status/note 等写接口调用 `task-audit`；可选新增 `POST /v1/tasks/:id/command` 仅供内部/脚本 |
| `app/src/app.ts` | `sweepRunners()` 里调用 `sweepStuckTasks`；日志里不输出命令原文中的敏感内容 |
| `app/config.ts` | `scheduler.stuckWarnMs`、`runnerTail.tailBytes`、`runnerTail.maxChars` 可选配置 |
| `app/prompts/system.md` | 只在需要时补一句：卡住可用 `task action=log` 自查，不要向用户暴露命令语法 |

### 4.3 不改

- 不改任务池模型，不建真实 IM 群。
- 不改 Web 前端。
- 不改 `runner.jsonl` 的写入方式。
- 不减少常驻工具、不引入 `tool_search` / deferred exposure；审计靠工具调用时的副作用完成。

---

## 5. 对外接口（内部）

### 5.1 task 工具

```ts
task action="log"       id=307 lines=8
task action="update"    id=307 acceptance="补一条：只读准入也要验证"   # 运行前改需求
task action="resume"    id=307 instruction="按 viking/fix-307 分支继续，先补写路径测试"
task action="interrupt" id=307 instruction="先别改写路径，回头核对只读准入"  # 仅 running
task action="stop"      id=307
```

返回给 bot 的是人话摘要，例如：

```
#307 最近活动：静默 2 分 13 秒。
最后工具：bash（completed）go test ./service/rs/
最后输出：ok .../service/rs 0.761s
最后助手文本：正在核对 data_scope=4 的读路径
```

### 5.2 HTTP（可选）

```
POST /v1/tasks/:id/command
{ "line": "/log 8" }
```

响应：

```json
{ "ok": true, "command": "log", "result": "任务 #307 最近活动…" }
```

只用于运维脚本和测试；不作为用户入口。它是**显式调用**，会执行动作并同样落审计，不是“解析任务池里的审计事件”。

审计读取直接复用现有接口：

```
GET /v1/tasks/:id/events?limit=50
```

返回里包含 `internal=true` 的指令事件；前端/脚本按 `meta.kind === "task_command"` 过滤即可回放。

---

## 6. 测试计划

1. **runner-tail 单测**
   - opencode：`text` + `tool_use` + `step_*` 混合，能取到最后文本 / 工具 / 时间。
   - `tool_use` 含 `attachments` / base64 / `metadata`，摘要里必须没有这些字段。
   - `input` 含数据库密码、Bearer token，输出必须被替换为 `***`。
   - 超过 `maxChars` 按最近优先截断。
   - `runner_started_at` 之前的旧轮事件被过滤。
2. **task-audit 单测**
   - `create/update/log/resume/interrupt/stop/cancel/retry/note/status` 每个写操作都落一条审计指令。
   - 审计事件 `internal=1`、`notify=false`：`unread()` 和 `recentMessages()` 看不到，`listTaskEvents()` 看得到。
   - `meta.audit_only=true`；参数脱敏、instruction 限长。
   - 审计写入失败不影响主操作。
3. **task-controls 单测**
   - `/log` 只读日志、不启停进程；结果同步返回。
   - `/resume` 缺 session、正在跑时报错，不写脏状态。
   - `/resume "要求"` 调用 `resumeTask` 时带上 `instruction`，并写 note + 结果事件。
   - `/interrupt`：运行中任务先 `stopTask` 再带 `instruction` resume；没在跑时拒绝，不调用 `stopTask` / `resumeTask`；缺 session 时拒绝。
   - `/interrupt` 连续调用被互斥锁挡住，不会重复停进程。
   - 运行前改需求：`task action=update` / 审批补丁只改 DB 和任务文档，不启动进程。
   - `/stop` 复用 `stopTask`，任务回到 `pending`。
   - 没有“写 `/resume` 再被解析执行”的第二条路径，不会重复恢复。
4. **巡检测试**
   - running + 静默超阈值 → 写一条普通事件、`notify=true`、只报一次，并附一条 internal `/log (auto-stuck)` 审计。
   - 进程已死 → 交给 `sweepDeadRunners`，`sweepStuckTasks` 不重复报。
5. **回归**
   - `npm run typecheck`
   - `npm test`
   - `npm run build`

---

## 7. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 工具输出含密钥 | 摘要前统一脱敏；只取前后几行；禁止原样落任务池 |
| 日志太大 | 只读尾部 512KB；单条输出截断；总字符上限 |
| opencode `text` 很少 | 以 `tool_use` 为主；明确写“本轮没有助手文本” |
| 恢复轮次混日志 | 用 `runner_started_at` 过滤；不用文件名/offset |
| 命令被用户看到 | 命令事件 internal；UFA 只转述人话；提示词不教用户语法 |
| 审计事件被误当命令执行 | `meta.audit_only=true`，不挂任何解析监听器；动作只由工具/API 执行 |
| 审计刷屏 | 只审计写操作；读操作不记；单任务面板可见但不进未读 |
| 自动上报刷屏 | 每轮执行只报一次；优先静默摘要，抑制重复的长任务提醒 |
| 不同执行器格式不同 | 先保证 opencode / mimo；其它返回兜底提示 |
| `/interrupt` 丢掉半个步骤 | 执行器无 stdin 通道，只能杀掉再续；结果事件写明中断点，恢复后由模型自检 |
| `/interrupt` 与 `/resume`/`/stop` 并发 | 每个任务一把进程内互斥锁，命令串行执行 |

---

## 8. 工具集不变（已定）

**结论：不为了审计改工具集。** 原有 14 个工具全部保留，不改成 `deferred`、不引入 `tool_search`、不改成“纯提示词 + 文本命令”。

理由：

- 本次目标是**任务操作可追溯、方便审计**，不是省工具 schema。审计靠工具调用后的副作用完成：动作照常执行，再往任务池写一条 `internal` 指令事件。
- 工具 schema 提供参数类型和失败返回；把 `resume` / `interrupt` / `stop` 改成模型在正文里写命令，解析错会停错任务或丢上下文，收益不值这个风险。
- 工具清单稳定，前缀缓存也稳定。动态 deferred 会改变工具声明，模型频繁激活工具时反而可能更贵。

代价：UFA 每轮仍要带约 11.9k chars（粗估 3k tokens）的工具 schema。这是为“结构化调用 + 可审计”付的固定成本，接受。

如果以后单独要做工具瘦身，可以另起方案用 SDK 的 `exposure: "deferred"` + `tool_search`；它和本方案正交，不影响 `/log`、`/interrupt` 和审计事件。

---

## 9. 待拍板

1. 审计范围是否只覆盖写操作？读操作（`list/get/updates/log`）默认不记；如果也要审计“谁看过任务”，可以把 `log` 也记一条，但 `list/get` 建议不记。
2. 静默阈值默认 5 分钟是否合适？要不要按 `eta_ms` 的比例算（例如 `max(3min, eta/3)`）？
3. `/stop` 后任务停在 `pending` 还是 `blocked`？现在 `stopTask` 回 `pending`，语义上是“可再恢复”。
4. `/interrupt` 的优雅停止窗口默认 5 秒是否够？执行器在大命令（构建、测试）中途被杀可能留下锁文件/半成品，要不要单独配置 `interruptGraceMs`？
5. 自动上报是否要直接发到用户聊天，还是只写任务池等 UFA 转述？当前方案选后者，符合“用户不需要知道”。
6. `task action=log` 是否允许 UFA 在普通对话里随时调用？建议允许，但只在任务卡住、用户问进度时用，避免每轮都抓日志。
