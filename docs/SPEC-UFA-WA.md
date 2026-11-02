# SPEC：UFA / WA 双 Agent 改造

> 配套 `ARCH-UFA-WA.md`（行为约定）。这份是**实现规格**：表结构、接口、状态流转、验收断言。
> 照着写就行，不用再猜。

---

## 0. 目标与不做

**做**：
- 拆两个 runner：UFA（接人）和 WA（干活），各跑各的会话
- 任务面板（SQLite 表）作为两者唯一交接面
- 记忆加时间维度
- 删掉 tide / energy / wave

**不做**：
- 不做多用户并发（当前单用户）
- 不做 WA 并发（先串行，一次一个任务）
- 不做主动找用户（留空，见第 9 节）
- 不改 `api.ts` 的现有路由，只加新路由

---

## 1. 模块划分

```
src/
  agent/
    engine.ts        ← 保留，改成可传入不同 system prompt + 工具集
    prompt.ts        ← 拆成 ufa-prompt.ts / wa-prompt.ts
  ufa/
    runner.ts        ← 新：UFA 主循环
    window.ts        ← 新：30s 等待窗口
  wa/
    runner.ts        ← 新：WA 主循环
    scheduler.ts     ← 新：定时任务到点检查
  core/
    tasks.ts         ← 新：任务面板读写
    memories.ts      ← 改：加 valid_from / valid_to / superseded_by
    energy.ts        ← 删
    wave.ts          ← 删
    tide.ts          ← 删
    plans.ts         ← 删（被 tasks 取代）
```

**提示词目录**新增：
```
data/sandbox/prompt/
  ufa-system.md      ← UFA 常驻（人格 + 路由）
  ufa-scene-*.md     ← UFA 场景
  wa-system.md       ← WA 常驻（纯效率，无人格）
  wa-scene-*.md      ← WA 场景
```

---

## 2. 数据表

### 2.1 新表 `tasks`

```sql
CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,          -- 谁的任务
  pool_id       TEXT    NOT NULL,          -- 从哪个池发起的
  goal          TEXT    NOT NULL,          -- 一句话：做什么
  deliverable   TEXT    NOT NULL DEFAULT '', -- 产出物
  constraints   TEXT    NOT NULL DEFAULT '', -- 约束
  acceptance    TEXT    NOT NULL DEFAULT '', -- 验收
  files         TEXT    NOT NULL DEFAULT '[]', -- JSON 数组，关联文件
  status        TEXT    NOT NULL DEFAULT 'pending',
                                           -- pending | running | blocked | done | failed | cancelled
  note          TEXT    NOT NULL DEFAULT '', -- 自由文本：卡在哪、需要什么。状态是隐式的，就靠这个
  result        TEXT    NOT NULL DEFAULT '', -- 最终产物摘要 / 结论
  artifact      TEXT    NOT NULL DEFAULT '', -- 可追溯产物路径 or 引用
  start_at      INTEGER NOT NULL,          -- epoch ms，<= now 表示立即
  end_at        INTEGER,                   -- 实际结束时间，null 表示未完
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_start ON tasks(start_at);
```

**`status` 的用途**：只用来查询和排序，**不用它驱动状态机**。WA 的判断依据永远是 `note` 里那句人话。
`blocked` 就是 `status='blocked'` + `note` 里写清卡在哪；用户答完之后，UFA 追加到 `note`，把 `status` 改回 `pending`。**没有转换表，就是一个字段两个值。**

### 2.2 改表 `memories`

```sql
ALTER TABLE memories ADD COLUMN valid_from    INTEGER;  -- NULL 视为 created_at
ALTER TABLE memories ADD COLUMN valid_to      INTEGER;  -- NULL = 至今有效
ALTER TABLE memories ADD COLUMN superseded_by INTEGER;
ALTER TABLE memories ADD COLUMN kind_ext      TEXT;     -- 'plan' 时带到期时间，ISO 字符串
```

**检索函数签名**：
```ts
searchMemories(opts: {
  userId: string;
  asOf?: number;        // 不传 = 当前有效（valid_to IS NULL）
  query?: string;
  limit?: number;
}): Memory[]
```

`asOf` 传了就查那个时刻有效的：`valid_from <= asOf AND (valid_to IS NULL OR valid_to > asOf)`。

### 2.3 删表

```sql
DROP TABLE tide_events;
```

`plans` / `plan_fires` 保留读不写，等 `tasks` 跑通一周再删。

---

## 3. 运行时接口

### 3.1 消息入口

```ts
// src/ufa/runner.ts
export interface UfaInput {
  poolId: string;
  userId: string;
  messages: MessageRow[];   // 一批（可能是 1 条，也可能是窗口内积压的 N 条）
  trigger: "message" | "window-expired" | "task-updated";
}
export function runUfa(input: UfaInput): Promise<void>;
```

`trigger` 决定走哪个 scene 文件：
- `message` → `ufa-scene-message.md`（判断完整 / 完整就回 / 不完整就延）
- `window-expired` → `ufa-scene-window.md`（窗口到点，一次性看全部）
- `task-updated` → `ufa-scene-task.md`（WA 交活了，转述给用户）

### 3.2 等待窗口

```ts
// src/ufa/window.ts
export class DeferWindow {
  /** 开一个窗口；已有窗口则不重开（不递归） */
  open(poolId: string, delayMs = 30_000): void;
  /** 往窗口里塞消息，不重置计时 */
  push(poolId: string, msg: MessageRow): void;
  /** 窗口到期，吐出全部积压并清空 */
  drain(poolId: string): MessageRow[] | null;
  /** 用户说「别等了」时提前引爆 */
  flush(poolId: string): MessageRow[] | null;
  cancel(poolId: string): void;
}
```

**关键约束**：`open()` 在已有同 pool 窗口时**直接返回**，不刷新定时器。这是「延迟读不递归」的唯一实现点。

### 3.3 任务面板

```ts
// src/core/tasks.ts
export type TaskStatus = "pending" | "running" | "blocked" | "done" | "failed" | "cancelled";

export function createTask(t: Partial<Task> & { userId: string; poolId: string; goal: string }): Task;
export function getTask(id: number): Task | null;
export function listTasks(filter: { userId?: string; status?: TaskStatus; dueBefore?: number }): Task[];
export function updateTask(id: number, patch: Partial<Pick<Task, "status" | "note" | "result" | "artifact" | "end_at">>): void;
export function appendNote(id: number, line: string): void;
export function cancelTask(id: number): void;   // 只置 status，不杀进程
```

### 3.4 WA 主循环

```ts
// src/wa/runner.ts
export function startWa(): void;
// 内部循环（每 2s 一次，不需要更密）：
//   1. 取 status='pending' AND start_at <= now 的任务，按 (start_at, id) 升序取第一条
//   2. 置 running，写 updated_at
//   3. 起独立 session，跑完
//   4. 写回 result / artifact / status
//   5. 触发 UFA（trigger="task-updated"）
```

**并发 = 1**。取不到就 sleep，不轮询数据库太频繁。

**取消检查**：每完成一次工具调用检查一次 `tasks.status`，是 `cancelled` 就在**这一步结束后**停，写回「停在哪、有没有半成品」。

---

## 4. HTTP API（沙盒内 `rb` 客户端用）

沿用 `api.ts` 的 `{ok, data}` 约定，都要 Bearer token。

```
GET    /v1/tasks?status=&limit=          列出任务
POST   /v1/tasks                         登记任务 {goal, deliverable, constraints, acceptance, files, start_at}
GET    /v1/tasks/:id                     单条
POST   /v1/tasks/:id/note                追加一行说明 {line}
POST   /v1/tasks/:id/cancel              取消
POST   /v1/tasks/:id/status              改状态 {status, result?, artifact?}
GET    /v1/memories?asOf=&q=&limit=      查记忆（asOf 走时间维度）
```

---

## 5. 消息处理时序

```
用户消息到达（adapters 收到）
  │
  ├─ 写 messages 表
  │
  ├─ DeferWindow 有该 pool 的窗口？
  │    ├ 有 → push()，结束。不唤醒 UFA。
  │    └ 无 → runUfa({trigger:"message", messages:[新消息]})
  │
  └─ UFA 返回：
       ├ {type:"reply", text}      → 发出去
       └ {type:"defer", ms:30000}  → DeferWindow.open(poolId, ms)
                                     窗口内新消息只 push，不唤醒
                                     到期 → runUfa({trigger:"window-expired", messages: 全部积压})
```

### 5.1 UFA 的输出契约

```json
{ "type": "reply", "text": "..." }
{ "type": "defer", "ms": 30000 }
{ "type": "reply", "text": "...", "tasks": [{ "goal": "...", "deliverable": "..." }] }
```

第三个是「回话 + 顺手登记任务」一起返回，一次调用干两件事。

### 5.2 边界（实现时必须逐条覆盖）

| # | 情况 | 期望行为 |
|---|---|---|
| B1 | 窗口期内又来消息 | push 入队，**不重开定时器** |
| B2 | 定时器响的同一刻有新消息 | 新消息也 drain 进这一批 |
| B3 | UFA 正在生成时来消息 | 入队，等本轮结束再处理；**不中断** |
| B4 | WA 回写任务时 UFA 正在生成 | 等 UFA 结束，再以 `task-updated` 唤醒 |
| B5 | 用户发「别等了 / 就这样」 | `flush()` 立即引爆窗口 |
| B6 | 窗口内连发多张图 | 全部按到达顺序 drain，一次给 UFA |
| B7 | 进程重启时窗口正开着 | 窗口不持久化，重启后按普通新消息处理（可接受） |
| B8 | 同一 pool 有多个窗口 | 不可能，`open()` 幂等 |

---

## 6. 提示词

### 6.1 UFA（`ufa-system.md`）

保留现有 `system.md` 的人格部分，删掉所有「干活」相关的工具说明。

工具只给：
- `read_file`（单次 ≤500 字符）
- `write_file`
- `create_task` / `get_task` / `list_tasks` / `cancel_task`
- `search_messages`（SQL）
- `search_memories` / `write_memory`

**不给**：shell、网络、图片处理。

### 6.2 WA（`wa-system.md`）

**没有任何人格描述**。从第一行起就是效率。

工具给全量：shell、文件读写、网络搜索。

输出格式固定：

```
## 结果
<一句话结论>

## 产物
<路径或引用>

## 卡点
<如果没做完，写清楚卡在哪、需要什么；做完了就写「无」>
```

---

## 7. 验收断言

每条都能写成测试，写在 `test/ufa-wa.test.ts`。

- [ ] **A1** 单条完整消息 → UFA 立即回，不进窗口
- [ ] **A2** 单条不完整消息 → UFA 返回 defer，窗口开
- [ ] **A3** 窗口内再发 3 条 → `open()` 未重开，定时器仍在 T+30s 触发
- [ ] **A4** 窗口到期 → 一次 UFA 调用收到全部 4 条
- [ ] **A5** 用户发「别等了」→ 窗口提前引爆，不进 30s
- [ ] **A6** UFA 生成中收到消息 → 消息入队，生成完成后处理，输入不丢
- [ ] **A7** UFA 返回带 `tasks` → 库里多一条 `pending` 任务
- [ ] **A8** `start_at` 在未来的任务 → WA 在到点前不取
- [ ] **A9** `start_at` 到点 → WA 取走并置 `running`
- [ ] **A10** WA 完成后 → `status='done'` + `artifact` 非空 + 触发 `task-updated`
- [ ] **A11** WA 报卡点 → `status='blocked'` + `note` 非空
- [ ] **A12** 用户答完 → `note` 追加，`status` 回 `pending` → WA 重新取到
- [ ] **A13** 取消 → 当前工具调用跑完才停，`note` 写清停在哪
- [ ] **A14** 记忆写 `valid_to` 后 → `asOf=now` 查不到，`asOf=过去` 查得到
- [ ] **A15** `supersede` 后 → 旧条目 `valid_to` 被填，`superseded_by` 指向新条目
- [ ] **A16** 两个同时间 `start_at` 的任务 → 按 `id` 升序，串行执行
- [ ] **A17** 删掉 energy/tide/wave 后 → `npx tsc --noEmit` 干净，无悬空 import

---

## 8. 迁移步骤

1. **加表**：`tasks`（2.1）
2. **改表**：`memories` 四个字段（2.2）
3. **写 `core/tasks.ts`**，先只做 CRUD，跑通 A7/A8/A9
4. **拆提示词**：`ufa-system.md` / `wa-system.md`，UFA 侧把工具砍掉
5. **写 `ufa/window.ts`**，跑通 A1–A6
6. **写 `wa/runner.ts`**，跑通 A10–A13
7. **记忆时间维度**，跑通 A14/A15
8. **删 energy / tide / wave / plans**，跑通 A17
9. 改 `app.ts` 接线，`pm2 start`

**每步一个 commit**，第 8 步之前不要删任何东西。

---

## 9. 留空的部分

**主动找用户**：不做。

理由：触发条件取决于 UFA 实际跑起来的活跃节奏。现在定等于猜。等跑一周，看 `messages` 表里 UFA 主动 vs 被动回复的比例，再定。

**WA 并发 > 1**：不做。串行够用，等真堵了再说。

**定时任务撞车**：按 `(start_at, id)` 升序串行，不做优先级。
