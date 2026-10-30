# 充能模型代码评审请求

## 背景

`rabbit-bot` 是一个 IM 聊天机器人（人设：鲸鱼娘），跑在飞书上。它有两种说话方式：
用户发消息后的**回答**，以及没人说话时的**主动开口**。

主动开口的频率由一个标量 `E`（「关系电量」）控制：用户回得及时、回得多 → 充能；
她自己起话头 → 消耗。设计文档在 `docs/energy-model.md`（12 节，含推演、参数扫描、13 条已知坑）。

**本文件请你审的是实现代码，不是设计。**

## 核心机制

```
E ∈ [floor, cap] = [1, 8]

s    = sigmoid((E - mid) / scale)            mid = 3.8, scale = 0.9
I(E) = coldMin * (1 - s) + hotMin * s        coldMin = 240 分钟, hotMin = 3 分钟

可以开口 ⟺ E >= floor  且  (now − 她最后说话时刻) >= I(E)
```

**消耗**
- 跟她上一句间隔 5 分钟内、且上一句是他说的 → 判定为「回答」，−0.1
- 否则 → 判定为「自己起话头」，−1.0
- 10 分钟内连发的多条 → 同一轮，只扣一次
- 任何消耗都不能把 E 扣到地板以下：`cur = Math.max(floor, cur − cost)`

**充能**
- 她说完 → 他回：按回复延迟分档 `+0.03`（隔一天）到 `+1.0`（1 分钟内），不超过 `cap`

**冷却**
- 每过一段**活跃时段**（本地 08:00–24:00）内的时间，E 向 `floor` 指数衰减，半衰 8 小时

## 实现位置

| 文件 | 内容 |
|---|---|
| `src/core/energy.ts` | 纯函数：`band` / `settle` / `interval` / `cool` / `replay` / `verdict` |
| `src/core/db.ts` | `messagesForWave` / `messageBefore` / `lastSelfMessage` |
| `src/app.ts` | `energyAccrue`（每个 tick 记账）、`energyTick`（每个 tick 判定） |
| `test/energy.test.ts` | 16 条单测 |

状态持久化在 kv 表：`energy.<poolId>` = `{"E": 7.8, "ts": 1793366419364, "day": "2026-10-29"}`。

## 运行方式（这是所有边界的来源）

调度器**每 3 分钟**跑一次 tick：

1. `energyAccrue(poolId, now)`：把 `st.ts → now` 之间新增的消息重放到 `E` 上，写回 `{E, ts: now}`
2. `energyTick(poolId, now)`：拿当前的 `E` 判定这一刻能不能开口

**每一次只处理一个 3 分钟的窗口。** 消息是持续的，调用是切片的。

## 已经修掉的四个（不要重复报告）

1. `replay` 开头整体冷却一次、循环里又逐段冷却一次 → 冷却翻倍
2. 判定基准用「任何人最后说话」而非「她最后说话」→ 热聊时永远够不到 `I(E)`
3. `toMin` 返回 epoch 分钟（约 2900 万），而 `activeSpan` 期望当天分钟（0–1440）
4. 跨 tick 时 `prev` 为 `null`，窗口内她说的第一句被当成「起话头」扣 1.0 而非 0.1

## 请你审什么

**不要复述上面四条。** 找第 5 个、第 6 个同类问题——那种「模拟一次跑完全程时永远绿，
上线按 3 分钟切片才炸」的边界缺陷。

值得怀疑的方向（不限于此）：

1. **增量记账的其它边界**
   - 消息时间戳恰好等于 `st.ts` 或 `now` 时，`messagesForWave` 的 `>=` / `<=` 会不会把它算进两个相邻窗口或都不算
   - 同一毫秒出现多条消息时，`prev` 的推进与 `sameTurn` 判定
   - 消息乱序（ts 递减）时 `replay` 的行为

2. **单位与时间**
   - `toMin` 用 `getHours()*60 + ...`，跨天时 `t1 < t0`，`cool` 里 `Math.max(0, ...)` 会怎样
   - 还有没有别的地方混用了 epoch 毫秒 / epoch 分钟 / 当天分钟 / 小时

3. **状态损坏**
   - kv 里 JSON 解析失败、`E` 是 `NaN` / `Infinity` / 负数、`ts` 在未来、`day` 对不上
   - `setKv` 写失败时会发生什么

4. **跨天与时区**
   - `dayStart = now − ((now + 8h) % 24h)`，`day = new Date(dayStart).toISOString().slice(0,10)`
   - 这套在 UTC+8 之外的时区、或服务器时区不是 Asia/Shanghai 时会怎样
   - 一天从本地 00:00 算，但活跃时段从 08:00 开始——跨天结算时这两者是否自洽

5. **多池隔离**
   - `messageBefore` / `lastSelfMessage` 是否都按 `pool_id` 过滤
   - 两个池交替 tick 时 kv 键是否可能串

6. **重复调用**
   - `proactivePools` 若在同一个 `now` 被调用两次，`energyAccrue` 第二次会怎样（`st.ts` 已等于 `now`）
   - 额度检查用 `return []` 提前退出时，`energyAccrue` 是否仍然执行过

7. **参数极值**
   - `cap = floor` 时
   - `costInit > cap - floor` 时
   - `gain * band() > cap - cur` 的截断是否会让 `gained` 记错
   - `scale` 极小（sigmoid 变阶跃）时 `interval` 的两个端点

8. **测试覆盖**
   - 现有 16 条测试里，上面哪些边界没被守住
   - 缺哪条测试最可能放过下一个线上事故

## 交付格式

一份 markdown 评审报告，每条问题包含：

- **位置**：`文件:行号`
- **问题**：一句话说清
- **复现**：最小输入 / 最小调用序列（逻辑问题必须有）
- **后果**：会让电量算错成什么样子，用户会看到什么症状
- **严重度**：`会算错` / `会崩` / `只是难看`
- **建议**：怎么修，或者「需要先确认什么」

按严重度排序。**不确定的标「待确认」并说明卡在哪**，不要为了凑数编问题。
同一类问题合并成一条，不要拆成五条。


## 附：跑测试和复现

```bash
cd app
npx tsc -p tsconfig.json --noEmit     # 类型检查
npm test                               # 234 条测试
```

线上数据在 `app/data/rabbit-bot.db`（sqlite），表 `messages(ts, from_self, pool_id, text)`、
`kv(k, v)`。可以直接查真实消息流构造复现。
