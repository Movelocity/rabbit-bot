# rabbit-bot 改造计划：对齐 dsh-superagent 的 UFA/WA 分层与工具边界

> 评审稿。前置阅读：`docs/ARCH-UFA-WA.md`（行为）、`docs/SPEC-UFA-WA.md`（规格）、`docs/UFA-WA-MIGRATION-PLAN.md`（落地）。这三份已经把「为什么要拆」「tasks 表长什么样」讲完了；本计划只补 **dsh-superagent 验证过的分层与工具边界**，以及当前代码的真实差距。
>
> 状态：只做方案，不改代码。待拍板项见第 7 节。
>
> **前提更新（评审后）**：已决定关闭沙盒，`exec.shell.mode = "host"` + `approval.enabled = true`，脚本直接在宿主机执行。因此本计划不再讨论容器、挂载、只读绑定；`runtime/shared` 继续作为 WA 汇报落点（它是运行时目录，与沙盒无关）。
>
> **执行进度（2026-11-10）**：P0 工具集拆分、P1 汇报闭环、P3 工具边界已完成，`npm run typecheck` + 493 tests 全绿。P2（双引擎/30s 窗口）与 P4（删旧模型）未开始。

---

## 0. 结论先行

1. **先收工具集，不急着拆 session。** 代码里已有 `profile?: "ufa" | "wa"` 和 `ufaTools/waTools` 分支（`app/src/agent/tools.ts:59,885`），但没有任何调用点设置 profile，实际仍是一份全量工具。第一步只做「显式 profile + 白名单」，风险最低、收益最大。
2. **UFA 的工具边界按阶段来。** 单会话阶段先保留 `terminal`（host + 审批），否则 bot 没法在宿主跑脚本；WA 落地后再把执行工具整体移到 WA。`write_file` 仍建议不给。
3. **WA 汇报走 push，不走轮询。** 现状 `task-updated` 唤醒只落日志不转述（`app/src/app.ts` 里 `TODO(UFA runner)`，`relayed:false`）。这是最该补的一环。
4. **沙盒已关闭，不再管它。** `mode=host` + 审批已生效；计划不再涉及容器/挂载。`exec.dir` 仍指向 runtime（决定 `read_file` 根和 host cwd），`runtime/shared` 作为汇报落点。
5. **WA 形态先不换。** 继续用外部 `opencode`/`mimo` 一次性进程（`app/src/core/dispatch.ts`），P2 再评估是否改成 in-process PiEngine。

---

## 1. 现状盘点（代码级）

| 项 | 现在 | 差距 |
| --- | --- | --- |
| Session | 一个 `PiEngine`、一个长期 session（`app/src/agent/engine.ts`），构造时绑定一份 `systemPrompt` 和一套 `tools`（`app/src/app.ts:118`） | 没有 UFA/WA 两个引擎；`seenPools`、`pendingHandoff` 都是单份 |
| 工具集 | `createTools()` 返回全量：`chat/memory/plan/approval/task/worker/read_file/write_file/terminal/rb`（`app/src/agent/tools.ts:95-885`） | `profile` 字段已存在但没接线；`waTools` 从未被使用 |
| 任务面板 | `tasks` 表 + CRUD + `/v1/tasks` 已实现（`app/src/core/tasks.ts`、`app/src/api.ts`） | 基本可用 |
| WA 执行 | `dispatch.ts` 起 `opencode`/`mimo` 一次性进程，`work_dir` 由任务指定，回报走 `/v1/tasks/:id/complete` | 工作区已加 `runtime/shared` 落点和 `RB_SHARED_DIR`（未提交），需收尾 |
| WA→UFA 交接 | `task-updated` 唤醒只取 `pendingTick` + 记录任务，不转述（`app/src/app.ts` `handleWakeInner`） | **核心缺口**：`relayed:false` |
| 审批/worker | `approvals`、`workers`、`task events` 已实现 | 可用 |
| 执行模式 | 已切 `exec.shell.mode = "host"` + `approval.enabled = true`（`app/config/local.json`），不建容器 | 无隔离；`terminal` 需审批；沙盒相关改动不再纳入本计划 |
| 旧机制 | `tide`/`energy`/`wave`/`plans` 仍在 | 按 `UFA-WA-MIGRATION-PLAN.md` 最后删 |

**两个容易看错的地方：**

- `tools.ts` 末尾的 `d.profile === "wa" ? waTools : ufaTools` 是**半成品**：全仓库没有一处传 `profile`，所以它永远不会走 `waTools`。
- `task-updated` 已经有唤醒链路，但只做到「记录」，没做到「转述」。不是没入口，是没实现。

---

## 2. 目标架构

```
IM 消息
  → Hub 入池
  → Scheduler / 30s 窗口
  → UFA session（人格 + 路由）
        ├─ 读：read_file（限 runtime 根）、orchestrator 式查询、chat/memory
        ├─ 写：task create / note（写 DB，不写文件）
        └─ 收到 WA 汇报 → 转述给用户
              ↑ relay（push，持久队列）
WA 执行（外部 opencode/mimo 或未来的 in-process session）
  → 在 task.work_dir 干活
  → 写 runtime/shared/handoffs/task-<id>.md
  → POST complete（result 摘要 + artifact 指向文件）
  → 触发 task-updated → UFA 读文件、挑值得说的转述
```

与 dsh-superagent 的对应关系：

| dsh-superagent | rabbit-bot 对应 |
| --- | --- |
| Main Session（`dsh-superagent-router`） | UFA：聊天 + 路由 + 转述 |
| Executor Session（`dsh-superagent-worker`） | WA：`dispatch.ts` 的一次性执行进程 |
| `tool-fs write:false, edit:false` | UFA 的 `read_file` 只读、没有 `write_file`/`terminal` |
| `orchestrator_report` + relay | WA `complete` + `task-updated` + UFA 转述 |
| `AgentDelivery` / `Effects` 持久队列 | 现有 `RunQueue` + `wake_log`，可加 effects 表 |
| `orchestrator_read` 资源分页 | 现有 `chat search` / `rb` 查询 / task 事件 |

---

## 3. 设计决策（需要评审拍板）

| # | 问题 | 建议 | 理由 |
| --- | --- | --- | --- |
| D1 | WA 保持外部进程还是改 in-process PiEngine？ | **先保持外部** | 隔离好、现有 e2e 已覆盖；改 in-process 要自己做工具隔离和审批，收益不确定 |
| D2 | UFA 是否给 `terminal`？ | **单会话阶段先保留（host + 审批）；WA 落地后再移到 WA** | 你现在就是要它在宿主跑脚本，直接砍掉会让 bot 失去执行能力。边界靠审批，不靠工具缺失 |
| D3 | UFA 是否给 `write_file`？ | **不给**（任务描述走 tasks 表） | ARCH 写「UFA 可写文件」与「不干重活」冲突；建议以 tasks 表为唯一交接面 |
| D4 | UFA `read_file` 能读哪？ | **只读 runtime 根**（prompt/topics/skills/shared/files） | dsh 的 read-only host FS 是给 coding agent 的；聊天 bot 放开任意宿主路径收益低、风险高 |
| D5 | 汇报写文件还是只写 DB？ | **文件为正文，DB 存摘要 + artifact 路径** | 大文本不进 SQLite/上下文；UFA 需要时按路径读 |
| D6 | 转述哪些状态？ | **只转述 `done`/`failed`/`blocked`**，`progress` 不进 UFA | 避免刷屏；progress 留在任务池 |

---

## 4. 分阶段实施

### P0：工具集拆分（已完成）

- `createTools` 的 `profile` 改成**必填**，UFA/WA 两套工具数组；`read_file` 增加 `readRoot` 参数。
- `App` 构造 UFA engine 时传 `profile: "ufa"`、`readRoot: runtimeDir(cfg)`。
- UFA 不再给 `write_file`；`terminal` 仍按 host+审批开关。
- 消除「默认 fallback 到全量」的隐患（类型上必填，无默认分支）。
- 验收：单测断言 UFA 工具集（无 `write_file`；`terminal` 按 host+审批开关）和 WA 工具集（有）；`read_file` 越界到 `exec.dir` 被挡住。
- 回滚：本组改动可整体 revert；未加 config 开关，避免把全量工具重新变成默认可走的分支。

### P1：汇报闭环（已完成）

- `task-updated`：读 `tasks` + `runtime/shared/handoffs/task-<id>.md`（旧位置兼容） → 拼 UFA prompt → `engine.run` → `chat.send` 转述。
- 任务事件 tick 与审批触发的 `task-updated` 共用同一条转述链路；有终态任务才转述，否则照旧走原未读池逻辑。
- **防洪水（push ≠ 每条一推）**：
  - 源头批处理：`markPendingTick` 是单向闩锁，窗口内 N 个完成只置一次 pending；`takePendingTick` + `listTasksUpdatedSince` 一次取全。
  - 队列合并：`RunQueue.enqueue` 同类唤醒合并（pools/reasons 取并集），UFA 正在跑时后续唤醒继续折叠。
  - 窗口：任务 tick 默认 180s（`scheduler.taskTickMs`），完成天然落进同一个窗口。
  - 只转述 `done`/`failed`/`blocked`（D6），`progress` 不进 UFA。
  - 一次唤醒只发一条 digest：每池最多列 10 条，其余写「还有 N 个任务」。
  - 全局冷却：两次转述至少隔 5 分钟；冷却期内重新置 pending，游标不动，下一轮再发。
  - 幂等：`ufa.task_relay_cursor` 只前进，`task.id + updated_at` 不会重复；重启后从 kv 恢复。
  - UFA 可 `chat.skip`：这一批都不值得说就不发。
- 失败重试：模型出错或一条都没真发出去（被压住/适配器失败）时，保留任务池未读 + 重新置 pending，下一次任务 tick 再试。
- 持久化用 kv：`ufa.task_relay_cursor` + `ufa.task_relay_last_at`，没建完整 effects 表；重启后从 kv 恢复。
- 验收：3 个任务同一窗口完成 → 只唤醒一次、只发一条摘要；冷却期内不重复；同一批二次 tick 不重复转述。

### P2：UFA/WA 双引擎（按 ARCH）

- 抽 `app/src/ufa/runner.ts` 和 `app/src/wa/runner.ts`（或在现有 `handleWake` 上分叉）。
- UFA 走 30s 窗口（`ARCH-UFA-WA.md` 2.2）；WA 串行、按 `start_at` 取任务。
- 拆 `RunQueue`：UFA 与 WA 各自队列，避免 WA 长任务卡住 UFA。
- 验收：私聊/群@ 去抖行为不变；WA 长任务期间 UFA 仍能回消息。

### P3：host 模式下的工具边界与审批（已完成）

- UFA 的 `read_file` 通过 `readRoot: runtimeDir(cfg)` 固定在 runtime 根；不跟着 `exec.dir` 漂。
- `write_file` 只留在 WA 工具集；UFA 的写操作走 `task` / `memory`。
- `terminal` 在 host 模式必须走审批（`approval.enabled=true` 已开）；审批分类/拒绝在 `cmd-rules.ts` + `ApprovalGate`。
- 提示词同步改了：不再让 UFA `write_file` 写话题库，改为读 + `memory` kind=topic。
- 验收：单测覆盖「越界到 exec.dir 被挡」和 host 审批闸；493 tests 全绿。

### P4：清理旧模型

- 删 `tide`/`energy`/`wave`/`plans`，按 `UFA-WA-MIGRATION-PLAN.md` 的迁移表处理。
- 验收：`rg` 无残留；测试全绿；线上跑一周再删表。

---

## 5. 整体验收清单

- [x] UFA 工具集符合选定 profile：没有 `write_file`；`terminal` 只以 host + 审批形式存在（WA 落地后再移除）。
- [x] UFA `read_file` 不能读 runtime 根之外。
- [x] 任务完成 → `runtime/shared/handoffs/task-<id>.md` 存在 → UFA 转述一次。
- [ ] WA 长任务不阻塞 UFA 回复（P2）。
- [x] 重复 complete / 重启不会重复转述（游标存 kv）。
- [ ] 回滚开关可回到单 session 全量工具（当前靠 revert 本组改动；未加 config 开关）。

---

## 6. 风险

- **双引擎成本**：两个 session 的 token/内存翻倍；UFA 仍走现有日额度闸。
- **无隔离**：`mode=host` 下 UFA/WA 都以宿主用户跑，能读 `~/.config/rabbit-bot/env`；靠审批和独立 OS 账号，不是工具边界。
- **转述刷屏**：必须限频 + 只转述终态；否则任务多的日子会连续打扰用户。
- **持久队列复杂度**：先用 `wake_log` 幂等 key 过渡，别一上来就建完整 effects 表。

---

## 7. 决策落点（执行时按建议定）

1. WA 继续用外部 `opencode`/`mimo`，P2 再评估 in-process。
2. UFA 不给 `write_file`（已实现）；任务描述走 tasks 表。
3. UFA `read_file` 只读 runtime 根（已实现）；`terminal` 暂时保留。
4. 汇报文件 `shared/handoffs/task-<id>.md` 覆盖写（已按这个读）。
5. 30s 窗口本轮不做，先保留现有 tick/去抖节奏（P2 再动）。
