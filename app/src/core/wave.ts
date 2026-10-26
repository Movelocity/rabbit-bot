/**
 * 水位场（潮汐的连续版）：把「隔多久能再开口」从离散闸门换成一条随时间衰减的叠加场。
 *
 * 模型：一条消息是一个脉冲——前 delayMin 分钟内不响（不打扰期），随后升到峰值 1，
 * 再带长尾衰减。A(t) = Σ w_i · K(t − t_i)，A 过阈值 = 此刻可以问一句「有没有话说」。
 * 「说过之后泄流」不用记状态：上次真发主动（tide_events kind='fired'）就是泄流点。
 *
 * 刻意不叫波函数：没有相位就没有干涉，这是响应函数的线性叠加。
 *
 * 三条定标铁律（踩过）：
 * 1. wUser 必须 < thr。否则单条孤立消息峰值就过阈值，thr 从 0.35 调到 0.8 命中次数一模一样，
 *    整套机制退化成「距最后一条消息 N 分钟定时开口」。
 * 2. 不打扰期是整个场的属性，锚点是「最后一条发言（任何一方）」。少了这条，叠加只推后峰值
 *    不推后起爆点，刚聊完就被自己催着开口。
 * 3. 只作用于 L2（普通关心）。日期档和跟进到期是硬锚点，被水位拦住是最蠢的失败。
 */
import type { Store } from "./db.ts";

export interface WaveConfig {
  enabled: boolean;
  delayMin: number;   // 不打扰期
  peakMin: number;    // 峰位：从消息时刻算起第几分钟到达峰值 1
  thr: number;        // 触发水位
  wUser: number;      // 用户消息权重（必须 < thr）
  wSelf: number;      // 自己说出口的消息权重
  horizonH: number;   // 只累加这么久以内的脉冲（6h 后 K 已归零，再长是浪费）
  idleExemptMin: number; // 最后一条消息超过这么久就不拦了：这不是「刚聊完」，是「冷场了该开口」
}

export const WAVE_DEFAULTS: WaveConfig = {
  enabled: true,
  delayMin: 30,
  peakMin: 45,
  thr: 0.5,
  wUser: 0.4,
  wSelf: 0.25,
  horizonH: 24,
  idleExemptMin: 180,
};

export function waveCfg(c?: Partial<WaveConfig> | null): WaveConfig {
  const out = { ...WAVE_DEFAULTS };
  for (const [k, v] of Object.entries(c ?? {})) {
    if (v !== undefined && v !== null) (out as any)[k] = v;   // undefined 不能覆盖默认值
  }
  return out;
}

export interface Pulse { ts: number; fromSelf: boolean }

/** 平移 Gamma(2)：τ < d 时为 0；峰在 θ 且峰高 1；之后指数长尾。τ 单位秒。 */
export function pulseK(ageSec: number, cfg: WaveConfig): number {
  const d = cfg.delayMin * 60;
  const th = cfg.peakMin * 60;
  if (th <= d) throw new Error(`peakMin(${cfg.peakMin}) 必须大于 delayMin(${cfg.delayMin})`);
  if (ageSec < d) return 0;                       // 不打扰期：一点水都不加
  if (ageSec < th) {
    const u = (ageSec - d) / (th - d);
    return u * u * (3 - 2 * u);                   // smoothstep 上升，峰在 θ 处平滑落顶
  }
  // 幂律尾 p=1：τ=θ 时 1，τ=2θ 时 0.5，τ=8θ 时 0.125。
  // 这是「退潮档位」能给出等比递增间隔的原因：下穿 thr·2^-k 的时刻正好在 θ·2^k。
  return th / ageSec;
}

export interface WaveLevel {
  a: number;
  nUser: number;
  nSelf: number;
  ageMin: number | null;   // 距最后一条发言几分钟
  thr: number;
}

export function level(pulses: Pulse[], now: number, cfg: WaveConfig, drainedTs = 0): WaveLevel {
  let a = 0;
  let nUser = 0;
  let nSelf = 0;
  let newest: number | null = null;
  const horizon = cfg.horizonH * 3600e3;
  for (const p of pulses) {
    if (p.ts > now) continue;                    // 补录的未来时间戳不参与
    const age = now - p.ts;
    if (age > horizon) continue;
    if (newest === null || p.ts > newest) newest = p.ts;
    // 已经消费掉的脉冲（drained 之前）：只参与「最后一条多久之前」，不再供水位。
    // 少了这一条，泄流后窗口变空 → ageMin=null → 被「冷场豁免」误判成可以开口。
    if (p.ts <= drainedTs) continue;
    a += (p.fromSelf ? cfg.wSelf : cfg.wUser) * pulseK(age / 1000, cfg);
    if (p.fromSelf) nSelf += 1; else nUser += 1;
  }
  // 不打扰期是「整个场」的属性：锚点是最后一条发言，无论谁说
  if (newest !== null && now - newest < cfg.delayMin * 60e3) a = 0;
  return {
    a: Math.round(a * 1e4) / 1e4,
    nUser, nSelf,
    ageMin: newest === null ? null : Math.round(((now - newest) / 60e3) * 10) / 10,
    thr: cfg.thr,
  };
}

/** 扫描未来，返回第一个 A >= thr 的时刻；波已过峰则 null（只用于展示，不用于定时器）。 */
export function nextHit(pulses: Pulse[], now: number, cfg: WaveConfig, stepSec = 300, horizonH = 12): number | null {
  const end = now + horizonH * 3600e3;
  for (let t = now; t <= end; t += stepSec * 1000) {
    if (level(pulses, t, cfg).a >= cfg.thr) return t;
  }
  return null;
}

export interface WaveVerdict {
  ok: boolean;
  a: number;
  thr: number;
  nUser: number;
  nSelf: number;
  detail: string;
}

/**
 * 从库里算这个池此刻的水位。poolId=null 表示跨池（全局计划）。
 * 泄流点取「上次真发主动」——不用额外状态，回放天然可复现。
 */
export function waveGate(
  store: Store, poolId: string | null, now: number, cfgIn?: Partial<WaveConfig> | null,
): WaveVerdict | null {
  const cfg = waveCfg(cfgIn);
  if (!cfg.enabled) return null;
  const drained = store.lastTideFired(poolId)?.ts ?? 0;
  const rows = store.messagesForWave(poolId, now - cfg.horizonH * 3600e3, now);
  const lv = level(rows.map((r) => ({ ts: r.ts, fromSelf: !!r.from_self })), now, cfg, drained);
  // 只有「近期还在聊、但水位还没起来」才拦。冷场（最后一条超过 idleExemptMin）必须放行，
  // 否则水位恒为 0，普通关心就永远发不出去了。
  const recent = lv.ageMin !== null && lv.ageMin <= cfg.idleExemptMin;
  const ok = !recent || lv.a >= cfg.thr;
  const why = recent
    ? `水位 ${lv.a.toFixed(2)} ${lv.a >= cfg.thr ? "≥" : "<"} ${cfg.thr}`
    : lv.ageMin === null ? "这个池没聊过，不拦" : `最后一条在 ${lv.ageMin} 分钟前（>${cfg.idleExemptMin}），冷场该开口`;
  return {
    ok, a: lv.a, thr: cfg.thr, nUser: lv.nUser, nSelf: lv.nSelf,
    detail: `${why}（近 ${lv.nUser} 条他的、${lv.nSelf} 条我的）`,
  };
}

export interface SchedulePoint { at: number; level: number; stage: number }

/**
 * 一个会话之后「她会想起你」的时刻表。
 *
 * 首档：水位上穿 thr（普通一轮十几分钟）。
 * 之后：每下穿一档「峰值 × ratio^k」再给一个候选时刻。核是幂律尾，
 * 下穿 P·r^k 的时刻正好在 θ·r^-k，所以间隔天然等比递增（2,4,8,16 倍），
 * 聊得越多峰值越高、档位越多、序列越长。
 * 这些只是「可以问一句有没有话说」的候选点，发不发还要过话题和每日额度。
 */
export function waveSchedule(
  pulses: Pulse[], fromTs: number, cfg: WaveConfig,
  opt: { ratio?: number; maxStages?: number; horizonH?: number; floor?: number } = {},
): SchedulePoint[] {
  const ratio = opt.ratio ?? 0.5;
  const maxStages = Math.max(1, opt.maxStages ?? 4);
  const floor = opt.floor ?? 0.02;
  const end = fromTs + (opt.horizonH ?? 6) * 3600e3;

  const aAt = (t: number) => level(pulses.filter((p) => p.ts <= t), t, cfg).a;

  // 先找峰值，档位相对峰值定，不然聊得多反而永远下不去
  let peak = 0;
  for (let t = fromTs; t <= end; t += 60e3) peak = Math.max(peak, aAt(t));
  if (peak < cfg.thr) return [];

  const out: SchedulePoint[] = [];
  const marks = Array.from({ length: maxStages }, (_, k) => peak * ratio ** (k + 1)).filter((m) => m >= floor);

  let stage = 0;          // 0 = 等首档上穿，1.. = 等第 stage 个下穿
  let prevA = 0;
  let first = false;
  for (let t = fromTs; t <= end; t += 60e3) {
    const a = aAt(t);
    if (!first) {
      if (a >= cfg.thr) { out.push({ at: t, level: a, stage: 0 }); first = true; }
    } else if (stage < marks.length) {
      const mark = marks[stage];
      if (prevA >= mark && a < mark) { out.push({ at: t, level: a, stage: stage + 1 }); stage += 1; }
    } else break;
    prevA = a;
  }
  return out;
}
