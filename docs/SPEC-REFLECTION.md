# 自省（reflection）现状与偏移记录

> 2026-11-23。记录当前实现、配置、观测方式，以及「proactive 本意是主动搭话，后来偏成工作任务汇报」的判断依据。
> 设计初版见 [SPEC-PROACTIVE-URGENCY.md](SPEC-PROACTIVE-URGENCY.md)（2026-11-03）。

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

## 2. 当前行为（2026-11-23）

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

## 3. 数据与观测

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

## 4. 配置与关闭

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

**关闭方式**：`app/config/default.json` 里 `proactive.enabled=false`，然后 `pm2 restart rabbit-bot`。没有前端开关。

需要注意这是**总开关**：自省的 `urgency` 是主动发言唯一依据，关掉自省等于关掉主动开口。历史 `reflections` 行还在，但不再更新、不再被读取。若将来只想关「主动发言」而保留「想一想」，需要把开关拆成 `reflectionEnabled` 和 `proactiveSpeakEnabled` 两个。

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

当前默认关闭属于止血，不是结论。往下有两条路：

- **A. 恢复「主动搭话」语义**：把锚点和 thought 口径改回社交/关系向，任务提醒另走计划/日程。
- **B. 承认它是「任务汇报触发器」**：从聊天主动机制里拆出来，命名、配置、观测都按任务提醒重做。

---

## 7. 待决

- [ ] 选 A 还是 B，或者两套并存
- [ ] 是否把 `proactive.enabled` 拆成「自省」和「主动发言」两个开关
- [ ] 是否给管理台加一个只读的「自省记录」页（需要新增 `/v1/reflections`）
