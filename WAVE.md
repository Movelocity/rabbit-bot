# 水位场（WAVE）

把「这次主动该不该开口」从离散判定换成一条随时间涨落的场。**只作用于 L2（普通关心）**，
L0 日期档和 L1 跟进到期是硬锚点，不参与。

```
K(τ) = 0                            τ < delayMin        # 不打扰期
     = u · e^(1-u), u=(τ-d)/(θ-d)   τ ≥ delayMin        # 平移 Gamma(2)，峰在 θ 且峰高 1
A(t) = Σ w_i · K(t − t_i)                               # 叠加；过 thr 才算「现在可以说」
```

刻意不叫波函数：没有相位就没有干涉，这是响应函数的线性叠加。类比是水位——说得越多，水越高，
要等它退下去；触发一次就泄流。

## 三条铁律（都踩过）

1. **`wUser < thr`**。`w=1, thr=0.5` 时单条孤立消息峰就是 1.0，任何小于 1 的阈值都在同一格 5 分钟上
   被跨过——实测 thr 从 0.35 调到 0.8，命中次数一模一样，机制退化成「距最后一条消息 N 分钟定时开口」。
   现在 `wUser=0.4`，单条永远过不了，必须两条以上叠加。
2. **不打扰期的锚点是「最后一条发言（任何一方）」**，不是每条脉冲各自算。少了这条，两条相隔 10 分钟
   的消息里第二条还在自己 delay 段贡献 0，起爆点仍由第一条决定（34 分钟）——刚聊完就被自己催着开口。
3. **冷场必须豁免**。水位为 0 意味着永远不到阈值；如果没人说话就永远不开口，普通关心就死机制了。
   `ageMin > idleExemptMin`（默认 180 分钟）直接放行，交给每日额度管。

## 接线

| 位置 | 动作 |
|---|---|
| `src/core/wave.ts` | 纯函数：`pulseK` / `level` / `nextHit` / `waveGate` |
| `src/core/plans.ts` `due()` | `canFire` 之后再问 `waveGate`，只有 `anchorOf(p)==="L2"` 才问；结果写进 `tide_events` 的 `kind`（fired/skip）、`reason`、`wave_a` |
| `src/core/db.ts` | `messagesForWave(poolId, fromTs, toTs)` 取消息骨架；`tide_events.wave_a` 列（老库 ALTER 补） |
| `src/config.ts` | 校验 `peakMin > delayMin`、`thr ∈ (0,1]`、`wUser < thr` |

**泄流不存状态**：取这个池上一条 `kind='fired'` 的 ts 当 drained 点，之前的脉冲只参与「最后一条多久之前」，
不再供水位。这样回放天然可复现，也不用多一张表。

## 配置（`config/default.json` → `tide.wave`）

```json
{ "enabled": true, "delayMin": 30, "peakMin": 45, "thr": 0.5,
  "wUser": 0.4, "wSelf": 0.25, "horizonH": 24, "idleExemptMin": 180 }
```

`enabled:false` = 完全退回旧的「只按额度」行为，一行配置就能回滚。

## 观测

```bash
cd app
npx tsx scripts/wave-obs.ts --days 5                    # 全池
npx tsx scripts/wave-obs.ts --days 5 --pool feishu:xxx  # 单池
npx tsx scripts/wave-obs.ts --days 5 --thr 0.3          # 调参对比
```

只读打开数据库（`mode=ro`），pm2 在跑也能用。语义是「把每个 tick 当成一个 L2 计划到点」，量出来的是波的上限。

2026-10-26 实测（私聊池 353 条消息 / 5 天）：

```
水位命中 16（3.2/天）  冷场不归波管 975（68%）
拦下 450：不打扰期内 195，过了不打扰期但水位不够 255
命中间隔 p50 130min CV 1.46
```

判读方法：

| 现象 | 意思 |
|---|---|
| 「过了不打扰期但水位不够」占比高 | 阈值偏高或 `wUser` 偏低，普通关心被压得太狠 |
| 命中时水位普遍 0.9+ | 核太宽或 `thr` 太低，等于没闸门 |
| 命中间隔 CV < 0.3 | 又在走方波，检查是不是被额度而非水位主导 |

## 明确不做

- 不注册动态定时器：tick 5 分钟够，`nextHit` 只用于展示。
- 不做内容分级权重（长消息/带情绪更重）：先把形状跑稳。
- 不让水位决定**次数**：次数仍由 `dailyCap` 管，水位只管时机。

## 上线

```bash
cd app && npm run build && pm2 restart rabbit-bot
```

会话会因 `freshNext` 重新创建，不丢上下文（来源是 pool）。回滚：`tide.wave.enabled=false` + 重启。
