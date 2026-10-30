# 充能模型代码对抗性评审报告（续）

> 来源：`docs/REVIEW-energy.md`（审什么 + 交付格式）
> 审对象：`app/src/core/energy.ts`、`app/src/app.ts`（`energyAccrue` / `energyTick`）、`app/src/core/db.ts`、`app/test/energy.test.ts`
> 方法：逐文件自读 + 对照 `docs/energy-model.md`，并对怀疑路径做了最小调用序列验证。

## 范围说明

未复述 REVIEW 清单已列清的四个已知坑（replay 冷却双算、prev 基准错、单位换算错、跨 tick prev 丢失），
本次只找**之后同类**的边界缺陷。审法：只盯「纯函数单个窗口看起来是对的 / 全流程模拟一次跑不出来 /
上线按 3 分钟切片才炸」这条线。

---

## 第 5 条（新增，同类边界缺陷）：「她说完没人回 → 等 3 倍冷却」守卫在线上判定链路里不可达

- **位置**：`app/src/app.ts:190-192`（`energyTick` 的判定入口）；数据源错误在 `app/src/core/db.ts:319-324`（`lastSelfMessage`），正确语义在 `app/src/core/energy.ts:98-103`（`interval` 的 `lastWasHers`）。
- **问题**：`energyTick` 取「她最后说的」时刻（`lastSelfMessage`，只认 `from_self=1`），
  但把 `lastWasHers` **硬编码为 `false`**。`lastSelfMessage` 本身就不反映「她上句话之后有没有人接」，
  而 `false` 又恰好对应「已被回答 / 她刚收尾」—  — 两种情况都不能替代「**她说完、没人回**」。
  于是 `interval` 里 `lastWasHers ? base*3 : base` 的 3 倍分支在线上从不被走到。
- **复现**：最小输入 + 调用序列。
  - E = 7（热态），她上一条消息是主动开口（`from_self=true`），此前用户**未回**；
  - `now` 距她上句话 20 分钟。
  - `energyTick` → `energyAccrue` → `verdict(E=7, lastTalkTs=herTs, lastWasHers=false, now)` →
    `interval(7, false) ≈ 9.58min < 20min` → **`ok: true`**（设计应为 `interval(7, true) ≈ 28.75min > 20min → not ok`）。
- **后果**：没人理的主动开口，过了 `I(E)` 就重新放行 —— 她会接着说（自我链 / 自聊循环），
  E 被她自己反复扣；设计里「她说完没人回，别追——等三倍」在生产接线层形同虚设。
- **严重度**：`会算错`
- **建议**：`energyTick` 改用 `this.store.lastMessage(poolId)`（返回 `{ts, from_self}`，db.ts:327），
  `lastTalkTs = ts`、`lastWasHers = from_self`；`lastSelfMessage`（db.ts:319）仅作为「她最后说话」的补充语义、
  不作为判定基准。

## 第 6 条（新增，同类边界缺陷）：时间单位 / 日界 / 时区混用（只在在线路径上暴露）

- **位置**：`app/src/app.ts:118-121` 与 `app/src/app.ts:148-149`（`proactivePools` / `energyAccrue` 的
  `dayStart` / `day`）；`app/src/core/energy.ts:98-137`（`interval` / `activeSpan` / `cool`）与
  `app/src/core/energy.ts:155-160`（`replay` 内的 `toMin`）；`app/src/core/time.ts:13-15`（`dayKey` / `fmtLocal` 才是带时区的正确实现）。
- **问题**：充能模块三处各自实现「当天」：`dayStart = now - ((now + 8*3600e3) % 86400e3)`（硬编码 UTC+8）、
  `day = new Date(dayStart).toISOString().slice(0,10)`（UTC 日历）；`toMin` 用 `Date#getHours()*60+...`（**服务器本地时区**）；
  而 quiet hours、`dayKey`、`proactiveUsage` 用的 `dayKey(t0, cfg.timezone)` 是 tz-aware 版本。
  单位体系里有 epoch 毫秒 / 当天分钟 / 活跃时段混用，且时区来源三条都不同。
- **复现**：最小输入 + 计算（已用 node 实测）：
  - `now = new Date(2026, 9, 30, 8, 0, 0).getTime()` → `dayStart = 2026-10-29T16:00:00Z`
  → `toISOString().slice(0,10) = "2026-10-29"`，**差一天**（真实本地日为 `2026-10-30`）；
  - 服务器时区 ≠ Asia/Shanghai 时，`toMin`/`cool` 按本地时区取小时 → 活跃时段（08:00-24:00）整日错位。
- **后果**：跨天重置（`st.day !== day`）、隔夜结算、冷却衰减的基准全部可能跑在错误日界/时区上 →
  E 算错 → 主动开口节奏错（白天不该掉电却掉电 / 该掉的没掉）。
- **严重度**：`会算错`
- **建议**：全部改用 `app/src/core/time.ts` 的 `dayKey(ms, tz)` / `localDay` / `fmtLocal`；`dayStart` 按时区换算；
  `toMin` 按 tz 取当天分钟。

## 附：顺带验证、未列为第 5/6 条的同路径问题（不重复已知四条）

1. **E = NaN 时判定会放行** — `app/src/core/energy.ts`（`verdict`）。
   - 问题：`E < cfg.floor`、`idleMin < need` 两个守卫都靠比较，`NaN < x` 为 false，`NaN < NaN` 为 false → `ok: true`。
   - 严重度：`会算错`。建议：进入判定前 `Number.isFinite(E)` 前置校验。
2. **参数极值无人校验** — `energyCfg`（`app/src/core/energy.ts:60-72`）只 clamp `cap/floor/mid/scale`，
   `halfH <= 0`、`costInit > cap - floor`、`gain` 等未拦 → 极值时冷却/充能行为失真。
   - 严重度：`会算错`。建议：配置校验层补齐。
3. **消耗被 clamp 在地板** — `replay`（`app/src/core/energy.ts`）`cur = Math.max(cfg.floor, cur - cost)`，
   与设计「消耗可跌破地板、靠恢复段拉回」（`docs/energy-model.md` §6、§12 第 3 条）矛盾 →
   最后一次主动后 E 卡在地板而非跌破，"当天不能再主动"的边界形同虚设。
   - 严重度：`会算错`。

## 测试覆盖自查

- 现有 16 条单测覆盖：分档、隔夜结算、I(E)、冷却/恢复、红蓝充能、连发去重、地板、跨 tick prev、
  分段推进一致性、三分钟不掉 75%。
- **缺口**：第 5 条的错误在「接线层」（Store 接线 + `verdict` 参数接线）；第 6 条在 Date/day 计算层。
  `app/test/energy.test.ts` 只测纯函数，两处都跑不到 → 最可能放错下一事故的测试缺口是：为
  「她说完没人回 → not ok」补一条 verdict 接线用例，以及为 day key / tz 补一条边界用例。

## 结论

- 新增缺陷按严重度排序（均为 `会算错`）：**第 5 条 > 第 6 条**。
- 第 5 条是「全流程模拟（`scripts/sim-simple.ts` 的 `runDay` 本就实现对的 3 倍逻辑）是绿的，而
  生产 `energyTick` 接线没接上」— 和已知四条同类病：函数对、接线错。
- 第 6 条是「模拟用当天分钟直接传、从不造 Date；在线却在造错的 day key + 用错时区取小时」— 单位与日界
  只在在线路径上出问题。
- 建议：先修第 5 条接线（改 `lastMessage` + flag），再修第 6 条时间体系（统一 `core/time.ts`）；
  然后补 wiring 层回归测试，防止下一条同类事故再次只在切片线上出现。
