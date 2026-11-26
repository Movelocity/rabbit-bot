# 唤醒中止导致「已读未回」的排查与修复（2026-11-26）

> 记录现状与阶段性结论，供后续跟进。线上已修复并重启；周期性自检方案尚未实施。

## 1. 现象

主人在飞书私聊发消息后，机器人长时间不回。进程在线、调度器也在 tick，但会话池没有未读，看起来像「卡死」。

## 2. 时间线（2026-11-26）

| 时间 | 事件 |
|---|---|
| 16:55:44 | 私聊消息 #6406 入池 |
| 16:55:49 | 调度器入队 message wake |
| 17:00:49 | 上下文 140830 tokens ≥ 100000，开始交接 |
| 17:01:43 | 交接文档 #104 存档 |
| 17:01:43 | 本轮 `aborted:turn-timeout`，`sentCount=0`，耗时 353594ms |
| 17:01:43 之后 | 没有新的 wake；游标已到 6406，池子无未读，tick 空转 |

调度器状态正常（`last_tick_at` 持续更新，`debouncing: []`），进程也一直 online。所以不是死机，是消息被标记已读后再没有唤醒。

## 3. 根因

1. `turnTimeoutMs = 300000`（5 分钟），由 `runPrompt` 每轮独立计时。
2. 这一轮模型在大量读文件和调研，先被 turn-timeout 打断；打断后又触发了上下文交接（`contextTokenLimit = 100000`）。
3. 交接跑完，`engine.run` 返回 `aborted`（不是 `error`），但这条消息已经被 `hub.takeUnread()` 消费、游标推进。
4. 旧逻辑 `app.ts` 里只有 `res.error && !sent.length` 才回滚游标；`aborted` 不回滚，于是消息永久丢失。
5. `scheduler.tick()` 只看未读；没有未读就不会唤醒，也没有任何周期自检去发现「读过但一条没回」。

## 4. 已上线修复

### 4.1 后端：中止不再丢消息

- `app/src/app.ts:1175` 起：一轮结束且 `sentCount === 0` 时：
  - `error`：沿用原逻辑回滚游标 + 系统提示。
  - `aborted`：只对可重试原因（`turn-timeout` / `aborted`）回滚游标并立即重排一次唤醒；每个池同一批消息最多重试 1 次（`ABORT_RETRY_LIMIT = 1`，`app.ts:154`）。
  - 重试预算用完或不可重试（额度到顶、审批 halt、`loop-guard`）时，不再空转，由 `notifyAbort`（`app.ts:889`）给私聊池发系统提示，并写 `wake_log` 的 `abortGiveUp` 字段。
- 成功发出消息后清理重试记账，避免误伤后续消息。

### 4.2 新接口：唤醒摘要

- `GET /v1/wakes?limit=N`（`app/src/api.ts:462`）复用 `store.recentWakeLogs`，返回裁剪后的字段：`ts / type / reasons / pools / outcome / ms / sentCount / read / error`，不返回工具参数、工具输出和正文。

### 4.3 前端：概览「最近异常」

- `app/webapp/src/pages/OverviewPage.tsx:332`：最近 24 小时内 `aborted/error` 且 `sentCount === 0` 的唤醒显示为「未回复」，带池来源、原因、时间和消息摘要。
- 同一池后续出现成功唤醒（`outcome=ok` 或 `sentCount>0`）时，该告警自动消失（`OverviewPage.tsx:337`），避免自动重试成功后仍长期误报。

### 4.4 验证与部署

- `npm test`：788 个用例全过，新增「中止回滚重试」「重试成功」「`/v1/wakes` 裁剪」用例。
- `npm run typecheck`、`npm run web:typecheck`、`npm run build`、`npm run web:build` 全过。
- 已 `pm2 restart rabbit-bot`，前端产物已更新。

## 5. 现场恢复

- 重启后启动日志：`启动捡回未消费交接 #104，下一次唤醒将带给新会话`。
- 在 p1 私聊池本地补了一条「继续」（seq 6408，复用原发送者身份，没有走飞书入站）。
- 17:14:27 调度器 tick 唤醒：`handoffIncluded: true`，`ok`，发送 1 条；交接 #104 `consumed=1`；回复落库 seq 6409。
- 游标停在 6408，池子无残留未读，现场已恢复。

## 6. 阶段性结论

- 这是一类「进程活着、池子空转、用户只看到她不说话」的静默故障，只看健康检查发现不了。
- 即时回滚 + 一次重试已经覆盖「单轮超时中止」这一主路径。
- 仍然存在的缺口：
  1. 重试账本 `abortRetries` 只在内存，重启就清零，理论上每次重启可以多试一次。
  2. 进程在 `takeUnread()` 之后、`finish()` 之前崩溃时，既没有 `wake_log`，游标也已推进，现有逻辑完全发现不了。
  3. 重试预算用完后没有周期自检，消息会停在「已读未回」。
  4. 自检如果直接复用普通唤醒，可能对同一批消息反复烧额度。

## 7. 待跟进：周期性自检方案（未实施）

目标：tick 周期做确定性自检（纯 SQL/代码，0 LLM 调用），只对确认有嫌疑的消息开一次恢复唤醒，并保证额度有上限。

### 7.1 检测对象

- `wake_log` 中 `aborted:*` / `error` 且 `sentCount=0`，且该池之后没有新的 self 消息、也没有更新未读。
- durable in-flight 标记：唤醒开始前写 `(pool, read_seqs, started_at)`，`finish()` 时删除；启动/tick 发现超过 `turnTimeoutMs + margin` 的残留，视为进程中途死亡。

### 7.2 防无限烧额度

1. 只恢复 `turn-timeout` / `aborted`；额度到顶、审批 halt、`loop-guard` 不自动恢复。
2. 尝试账本落 SQLite（按 pool + seq 记次数），重启不清零。
3. 单条消息最多恢复 2 次，退避：立即 → 5 分钟 → 30 分钟。
4. 单池每小时最多 3 次、每天最多 10 次恢复，超限写 `skipped:recovery-budget`。
5. 熔断：同一池连续 3 次「读了但 0 发送」就停止恢复，只发系统提示并在前端标红。
6. 跳过条件：已有更新的 self 消息、已有新未读、暂停中、当日额度到顶。
7. 恢复轮使用更小的 tokens/calls 预算，并在 prompt 中要求「用交接文档直接回，不要重做已完成的工作」。
8. 每次自检和恢复都落 `wake_log`，前端能看到「恢复了 / 放弃了 / 为什么放弃」。

### 7.3 入口与开放问题

- 入口放 `scheduler.tick()` 最自然：和现有「有未读才唤醒」并列，不新增 LLM 轮询。
- 待定：
  - 恢复次数上限与退避参数是否做成配置项（默认值如上）。
  - 群聊池是否参与自动恢复（建议先只做私聊）。
  - 熔断后如何解除（手工恢复 / 下一条新消息自动解除）。

## 8. 观测入口

- API：`GET /v1/wakes?limit=N`
- 管理台：概览 →「最近异常」；观测 → 模型日志
- 命令行：`npm run ctl -- wakes 10`、`npm run ctl -- handoffs`
- 日志：`app/logs/app.log`（搜索 `唤醒 ... →`、`aborted:`、`abort-retry`、`系统消息（abort`）

## 9. 相关文件

- `app/src/app.ts`：中止处理、重试账本、`notifyAbort`
- `app/src/api.ts`：`/v1/wakes`
- `app/webapp/src/pages/OverviewPage.tsx`：「未回复」告警与恢复判断
- `app/webapp/src/lib/types.ts`：`WakeLogView`
- `app/test/pipeline.test.ts`、`app/test/api.test.ts`：新增用例