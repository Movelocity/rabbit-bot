# 自省 / proactive：拆除记录与重开发说明

> 2026-11-23。记录拆除前的实现、配置、观测方式，以及「proactive 本意是主动搭话，后来偏成工作任务汇报」的判断依据。
> 设计初版见 [SPEC-PROACTIVE-URGENCY.md](SPEC-PROACTIVE-URGENCY.md)（2026-11-03）。

> **结论（2026-11-23）**：这不是「参数调歪了」，是机制本身做错了。设计理念是**一切皆 tick**——
> 所有对话行为都由调度器 tick 驱动：tick 唤醒 Agent，读池，用户有新消息就回、没有新消息也可以决定
> 主动开口，然后结束。`proactive` / `reflection` 另开了一条「定时器 + 独立门控」的并行唤醒通道，
> 绕过了 tick，等于在同一套系统里造了第二个唤醒源。只有**完全的后台整理任务**（记忆梳理、上下文
> 交接等不面向对话的事情）才应该独立于 tick 运行。
>
> **这条通道已于 2026-11-23 整体拆除**，本文保留给后续重新开发 proactive 时参考。重开发时不要再起
> 定时器、不要再维护独立的 `next_at` / 门控状态，把「要不要主动开口」放进 tick 的决策里。

---

## 0. 拆除清单（2026-11-23）

- 删除文件：`app/src/core/reflection.ts`、`app/src/core/gate.ts`、`app/scripts/probe-proactive.ts`
- 删除测试：`reflection.test.ts`、`gate.test.ts`、`proactive-attempt.test.ts`
- 删除代码：`App.proactivePools` / `startReflectionLoop` / `reflectDue` / `runReflection` / `logProactiveThrottled`，`PiEngine.reflect`，`Scheduler.proactivePools`，`makeWake` 的 proactive 参数，`Wake.proactive` 字段，prompt 里的 proactive / silentStreak 状态行
- 删除配置：`config/default.json` 的 `proactive` 块，`Config.proactive` 字段与校验
- 删除数据表定义：`reflections`、`proactive_log`（旧库里已有的表不主动 drop，只是不再读写）
- 保留：`messagesForReflection` 消息窗口函数（风格闸还在用）、`lastUserMessageTs`、后台记忆梳理 `engine.review`


---

## 1. 它是什么

整条主动链路是三段：

```
自省（模型自己给 urgency / thought） → 门控（gate 六道门） → 主动发言
```

自省跑在一个**独立、无工具、in-memory 的 pi 会话**里（`src/agent/engine.ts` 的 `reflect()`），不落盘、不进聊天历史。它的产物只有两样：最新的 `reflections` 行，和 `proactive_log` 里的门控记录。

代码位置：

| 文件 | 作用 |
|---|---|
| `app/src/core/reflection.ts` | 提示词、JSON 解析、周期夹逼 |
| `app/src/app.ts` `reflectDue` / `runReflection` / `startReflectionLoop` | 什么时候跑、跑哪个池、落库 |
| `app/src/core/gate.ts` | 六道门，决定 urgency 够不够开口 |
| `app/src/core/db.ts` | `reflections`、`proactive_log` 两张表 |

---

## 2. 拆除前的行为（供重开发参考）

### 2.1 什么时候跑

`startReflectionLoop` 用 `setInterval` 扫描，间隔是 `clamp(scheduler.tickMs, 30s, 120s)`。默认 `tickMs=300000`，所以实际是**每 120 秒扫一次**，一次最多跑一个池（`reflectionBusy` 串行）。

单个池要同时满足：

1. `proactive.enabled === true`
2. 池不是 `task` / `schedule`
3. 平台适配器没停用、全局未暂停
4. 本池最后一条用户消息已过去 `proactive.reflectionDelayMs`（默认 300000ms = 5 分钟）
5. 最新一条自省的 `next_at` 已到点
6. 额度没见底（剩余 tokens ≥ 2000，且未到当日 LLM 调用上限）

### 2.2 下一次什么时候想

由模型输出的 `next_reflection_in`（秒）决定，解析时夹进 **3600 ~ 86400 秒（1 小时 ~ 1 天）**（`MIN_NEXT_SEC` / `MAX_NEXT_SEC`）。

- 缺这个字段或值非法：回退 `MIN_NEXT_SEC`（1 小时）
- 自省输出解析失败：`next_at = now + 1 小时`

### 2.3 输入

- 最近对话：先取最近 90 分钟、最多 40 条；不足 12 条时回退到「最近 12 条」
- 距最后一条用户消息多少分钟
- 上次主动开口的原话、对方有没有回
- 上一次自省的 `thought`（保持念头连续）
- 已连续主动说了几次没人回

### 2.4 输出

纯 JSON，六个键：

```json
{
  "thought": "此刻的判断，一到两句话",
  "style_hint": "如果开口，用什么语气",
  "urgency": 0.0,
  "topic_pick": "要不要说、说什么",
  "topic_angle": "从哪个角度切",
  "next_reflection_in": 3600
}
```

当前 `urgency` 锚点（注意已经是**工作任务口径**）：

```
0.0–0.2  手上没有正事，也没有新结果
0.3–0.5  有个小进展但没新结论，不急，可以等下次一起说
0.6–0.8  有可交付的结果、真正要他拍板的取舍或要给的权限/资源，或任务有风险
0.9–1.0  任务卡住/有风险/到点必须提醒，再不说会误事
```

---

## 3. 拆除前的数据与观测

> 下面两张表已不再创建/写入，只作为当年观测方式的记录。

| 表 | 内容 |
|---|---|
| `reflections` | 每次自省的 `thought / style_hint / urgency / topic_pick / topic_angle / next_at / created_at`，只留 7 天 |
| `proactive_log` | 每次门控决策（`speak` / `skip` + `reason` + `urgency` + 静默时长），用于查「为什么没说话」 |
| `usage_events` | 每次模型调用的 token / 成本，`source=llm` |

查某次自省：

```sql
SELECT datetime(created_at/1000,'unixepoch','+8 hours') t, pool_id, urgency, thought
FROM reflections WHERE pool_id='<pool>' ORDER BY created_at DESC LIMIT 10;
```

**前端看不到。** 管理台的「模型日志」（`/v1/llm-logs`）只读 `data/sessions/*.jsonl` 落盘会话，而自省用的是 `SessionManager.inMemory`，本来就不落盘；`reflections` 表也没有对应 API。目前唯一能看到的两个出口是 `app.log`（`thought` 前 60 字）和数据库。

---

## 4. 拆除前的配置（已随代码删除）

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `proactive.enabled` | **false**（2026-11-23 起） | 总开关，同时控制自省循环和主动发言 |
| `proactive.reflectionDelayMs` | 300000 | 用户最后一条消息后多久开始想 |
| `proactive.urgencyThreshold` | 0.35 | 私聊开口门槛（群聊见 `proactive.group`，0.6） |
| `proactive.minSilentMs` | 300000 | 全局静默下限 |
| `proactive.minIntervalMs` | 600000 | 冷却基准，按 urgency 缩放 |
| `proactive.maxPerDay` | 6 | 私聊每日主动次数上限 |
| `proactive.maxConsecutive` | 3 | 连说没人回的上限 |
| `proactive.quietStart` / `quietEnd` | 23:30 / 08:00 | 只拦开口，不拦自省 |

**当年的关闭方式**：`app/config/default.json` 里 `proactive.enabled=false`。2026-11-23 拆除后这些配置项全部不存在，也不需要开关——因为已经没有任何 proactive/reflection 代码在跑。

历史 `reflections` / `proactive_log` 行如果旧库里还在，保留但不读写；新库不会建这两张表。

---

## 5. 设计时间线（证据）

| 日期 | 提交 | 变化 |
|---|---|---|
| 2026-11-03 | `118258a` | 用「自省 + 门控」替换 `wave.ts` / `energy.ts` / `tide.ts`，净减 810 行。动机是旧机制 `Math.random() < 0.12` 跟「她想不想说」无关 |
| 2026-11-04 | `eaa0fad` | `thought` 从「你在想什么」扩成「先说心情和累不累，再说在想什么」 |
| 2026-11-11 | `d4ed07e` | 「收紧决策边界，低价值判断不再请示用户」。提示词改成扫任务和计划、只判断有没有要他拍板/给权限/可交付结果/真卡点；`thought` 要求写任务号、状态、卡点，「别写心情和空话」 |
| 2026-11-23 | 本次 | 周期从 5 分钟~3 小时改为 1 小时~1 天；`proactive.enabled` 默认关闭 |

---

## 6. 偏移分析

初版（`118258a`）的措辞明确是「主动搭话」：

- 问题：「此刻没人跟你说话，你在想什么？」
- 锚点：「有点想搭话，但不说也行」「确实有件事想说，憋着难受」「必须现在说，再不说就错过时机了」
- 语气示例：「随口问一句，别像在检查」

`d4ed07e` 之后变成「工作任务汇报」：

- 问题：「扫一眼手上的任务和计划，只判断有没有真需要他拍板、要他给权限或资源、可交付的结果、或真卡点」
- 锚点：「手上没有正事」「有可交付的结果」「任务卡住/有风险」
- `thought`：「写具体的任务号、状态、卡点，别写心情和空话」
- 语气默认：「同事同步，先结论后依据」

也就是说，**proactive 一开始确实是促使 Agent 主动开口（社交意义上的「想说话」），reflection 是它的驱动；后来为了压掉低价值请示，判定标准被换成了任务/工作正事**。结果：

- 记录读起来像工作汇报（例如「这是欧品会项目群……无指向我的待办、卡点或待拍板事项」），不像聊天 Agent 的念头；
- 群聊池几乎永远给低分，自省仍按 1~2 小时定期烧一次上下文（单次可能出现 60 万级 cache hit）；
- 用户感知变成「机制很奇怪、不知道什么时候设计的」——设计时间是 2026-11-03，偏掉发生在 2026-11-11。

但要看清的是：**即使把口径改回社交，这条并行通道本身仍然是错的。** 它违反的是更底层的「一切皆 tick」：

- tick 本来就是「Agent 被唤醒、看一眼所有池、决定说不说」的唯一时机；「有没有新消息」只是 tick 的输入之一，不是唤醒的必要条件。
- `reflection` 另外维护了一份「想不想说」的状态（`reflections` 表）、一套周期（`next_at`）、一套门控（`gate.ts`），等于把 tick 里本该由 Agent 当场做的判断拆出来，做成第二个调度器。
- 两个唤醒源还会互相打架：tick 在对话、reflection 在后台烧 token；门控拦下的和 Agent 自己决定不说的，是两套沉默语义。
- 唯一值得独立于 tick 的，是**完全的后台整理任务**——记忆梳理、上下文交接、日志/数据整理，这些不面向对话、不产生用户可见消息，才可以有自己的节奏。

所以当前默认关闭不是「调参止血」，而是承认这条通道应该退场。正确的形态是：把「主动开口」的判断收回 tick，Agent 在 tick 里同时看到「有没有未读」和「距上次说话多久」，自己决定回不回、要不要起个话头；`proactive_log` 里关于沉默的观测可以保留，`reflection` 定时器、`next_at`、独立门控这套壳则不该继续存在。

---

## 7. 重新开发时的约束与待决

**硬约束**：

- 不再起独立定时器、不再维护 `next_at`、不再做第二套门控；一切唤醒机会只从 tick 来。
- tick 里 Agent 同时看到「有没有未读」和「距上次说话多久」；要不要开口由它在同一轮里决定。
- 只有完全的后台整理任务（记忆梳理、上下文交接、数据整理）可以独立于 tick，且不产生用户可见消息。

**待决**：

- [ ] tick 里「距上次说话多久」怎么给（原来由 `reflectionDelayMs` 间接提供）
- [ ] 主动开口后来如果还要上限/冷却，放在 tick 的哪一层，避免又长成第二个调度器
- [ ] 是否给管理台加只读的「tick 决策 / 沉默原因」页
