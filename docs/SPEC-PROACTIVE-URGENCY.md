# SPEC：主动对话重做（urgency 驱动）

> 替换 `energy.ts` / `wave.ts` / `tide.ts` 三件套。
> 参考 Shikigami Protocol（AGPL-3.0）的 ASE 思路：**主动开口由模型自己产生的"想说程度"驱动，不由代码拍概率**。
> 只借思路，不复制代码。README 备注一句即可。
> 2026-11-03

---

## 1. 为什么换

现状是 `Math.random() < 0.12` 一类的概率。问题不在数值调不好，在于**这个数跟"她想不想说"没有关系**——它是代码拍的，所以用户感觉自己在跟一个概率模拟器打交道。

`energy.ts` 头注释里已经写了这个判断：wave 里同时活着 11 个概念，每个都说不清为什么是这个权重。再来一版还是同样的问题。

**换成三段**：

```
自省（她想不想说）→ 门控（现在该不该说）→ 发言
```

关键在第一步：**"想不想说"由模型自己判断，代码只负责拦。**

---

## 2. 数据模型

### 2.1 新表 `reflections`

```sql
CREATE TABLE IF NOT EXISTS reflections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  pool_id       TEXT    NOT NULL,
  thought       TEXT    NOT NULL,           -- 她此刻在想什么（不给用户看）
  style_hint    TEXT,                       -- 用什么语气说
  urgency       REAL    NOT NULL,           -- 0..1，想说的程度
  topic_pick    TEXT,                       -- 想聊的话题（可空）
  topic_angle   TEXT,                       -- 从哪个角度切
  next_at       INTEGER,                    -- 下次自省时间（模型自己定）
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reflections_user_time
  ON reflections(user_id, created_at DESC);
```

**只要最新一条**。不自省历史，不攒库。旧的留 7 天清掉。

### 2.2 新表 `proactive_log`

```sql
CREATE TABLE IF NOT EXISTS proactive_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT    NOT NULL,
  ts           INTEGER NOT NULL,
  decision     TEXT    NOT NULL,           -- 'speak' | 'skip'
  reason       TEXT    NOT NULL,           -- 见 §5
  urgency      REAL,
  silent_sec   INTEGER,
  cooldown_req INTEGER,
  msg_id       INTEGER                     -- speak 时指向 messages.id
);
```

**每次决策都写一行**，包括不说的。这是这版最重要的东西——线上能查"她为什么今天一天没说话"。

### 2.3 `kv` 加三个键

| key | 含义 |
|---|---|
| `ase:last_speak_at` | 上次主动开口时间戳 |
| `ase:consecutive_speaks` | 连说没人回的次数 |
| `ase:last_reflect_at` | 上次自省时间戳 |

`consecutive_speaks` 在**任何用户消息进来时清零**，且必须在门控之前执行（否则被拦的那次不会重置）。

---

## 3. 自省（reflection）

### 3.1 什么时候跑

- 用户最后一条消息后 **5 分钟**（没人说话，闲着也是闲着）
- 之后按模型给的 `next_at` 再来（自己定节奏，不是固定间隔）
- **单次自省不产生用户可见的消息**

### 3.2 输入什么

给她这些，不给全部聊天记录：

1. **最近 10 条消息**（原文，含时间戳）
2. **现在几点、距离上次对话多久**
3. **上次主动开口说了什么、用户有没有回**（这条决定她会不会变得谨慎）
4. **上次自省的 thought**（她想事情的连续性）

### 3.3 输出契约

**纯 JSON，六个键，不许有别的**：

```json
{
  "thought": "他在弄那个任务编排器，早上还说进展不快，现在这个点可能在吃饭",
  "style_hint": "随口问一句，别像在检查",
  "urgency": 0.42,
  "topic_pick": "晚饭",
  "topic_angle": "从他的忙碌切入，不直接问吃了没",
  "next_reflection_in": 1800
}
```

**urgency 的锚定**（必须写进提示词，否则模型会全给 0.5）：

| 值 | 含义 |
|---|---|
| 0.0–0.2 | 没什么可说的，只是例行想了一下 |
| 0.3–0.5 | 有点想搭话，但不说也行 |
| 0.6–0.8 | 确实有件事想说，憋着难受 |
| 0.9–1.0 | 必须现在说，再不说就错过时机了 |

**解析失败**（非 JSON / 缺键 / 越界）→ 记 `reflection_parse_error`，**当作 urgency=0**，不抛错、不重试超过 1 次。

---

## 4. 门控（gate）

六道，按顺序，**任一道不过就 skip 并记 reason**：

| # | 条件 | skip_reason |
|---|---|---|
| 1 | 没有 reflection，或 `urgency < 0.35` | `low_urgency` |
| 2 | 距离用户最后消息 < **300 秒** | `not_silent` |
| 3 | 距离上次开口 < `minInterval × (1 − urgency × 0.85)` | `cooldown` |
| 4 | 24 小时内已开口 ≥ **15** 次 | `daily_limit` |
| 5 | `consecutive_speaks ≥ 3` | `no_response` |
| 6 | 当前正在生成普通回复 | `chat_streaming` |

**第 3 道是核心**：冷却不是固定值。

- urgency = 1.0 → 冷却 ≈ 0（想说就说）
- urgency = 0.35 → 冷却 ≈ `minInterval × 0.70`（默认 600 秒时约 7 分钟）

**"多想说"和"能多快说"是同一件事**，不用另设一套"潮位"。

**第 5 道是 rabbit-bot 现在缺的**：她连说三次没人回，就闭嘴。用户一开口立刻清零。

**沉默时长要跨池算**：`max(本池最后消息, 全局最后消息)`。否则切 pool 会误判用户消失。

---

## 5. 发言

过了门控，用 `thought` + `style_hint` + `topic_angle` 拼提示词生成消息，**走正常发送链**（分段、间隔、表情都复用现有逻辑）。

发完：

- 写 `ase:last_speak_at`
- `consecutive_speaks += 1`
- `proactive_log` 记一行 `speak`，带 `msg_id`

**加一道自检**：生成结果如果命中 `（沉默）` `（不说话）` `...` 或纯空白 → **不发送**，记 `silence_output`，`consecutive_speaks` 不加。模型有权决定"想了半天不说了"，这本身是好事。

---

## 6. 可观测

```sql
-- 最近 24 小时为什么没说话
SELECT datetime(ts/1000,'unixepoch','localtime') t, decision, reason, round(urgency,2) u, silent_sec
FROM proactive_log WHERE ts > (strftime('%s','now','-24 hours')*1000)
ORDER BY ts DESC LIMIT 40;

-- 主动开口成功率（说了有回音的占比）
SELECT SUM(decision='speak') speaks, COUNT(*) total FROM proactive_log
WHERE ts > (strftime('%s','now','-7 days')*1000);
```

上线一周后看两件事：

- **`skip_reason` 分布**：如果 90% 是 `low_urgency`，说明提示词里的 urgency 锚定没定好
- **`speak` 后用户有没有回**：这是唯一真指标，比"说了几次"重要

---

## 7. 迁移

1. 建两张表 + kv 三个键
2. 写 `src/core/reflection.ts`（自省）和 `src/core/gate.ts`（六道门），都是纯函数 + 一个调度入口
3. `scheduler.ts` 里把 wave/energy 的定时器换成自省定时器
4. **`energy.ts` / `wave.ts` / `tide.ts` 全删**，相关配置项从 `default.json` 移除
5. 旧测试里跟 wave/energy 有关的删掉，新写 gate 的单测

**代码量预估**：`reflection.ts` ~180 行、`gate.ts` ~120 行、迁移净减 600 行以上。

---

## 8. 验收

- [ ] A1：连发三条主动消息、用户一条不回 → 第四条不再发（`reason=no_response`）
- [ ] A2：用户回一句 → `consecutive_speaks` 归零
- [ ] A3：urgency=0.9 与 0.4 各一次，后者等待时间明显更长
- [ ] A4：24 小时第 16 次被拦，`reason=daily_limit`
- [ ] A5：普通回复生成中触发的主动被拦，`reason=chat_streaming`
- [ ] A6：每次决策（含 skip）在 `proactive_log` 有且只有一行
- [ ] A7：模型返回非 JSON → 不抛错，`urgency` 按 0 处理
- [ ] A8：模型输出「（沉默）」→ 不发送，`consecutive_speaks` 不变
- [ ] A9：切 pool 后沉默时长按全局算，不误判
- [ ] A10：删掉 wave/energy 后 `npm test` 全绿
