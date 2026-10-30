/**
 * 充能模型（energy）：一个状态量 + 一个函数，替代原来的潮汐水位。
 *
 * 为什么换：`wave.ts` 里同时活着 11 个概念（脉冲、积分核、三种权重、总水位、峰值、档位、
 * 阈值、窗口、maxStages、delayMin、静默期），互相打架——10-29 下午 `stage > maxStages`
 * 和 `usedWaveStages` 对冲，让她连着三次没开口之后彻底不叫，四小时静默。
 *
 * 新模型只有两样：
 *   E     电量。他接她的话就充，她自己开口就耗，不聊就冷却。
 *   I(E)  距上次对话多久可以再开口。sigmoid 二级：E 高→几分钟，E 低→几小时。
 *
 * 完整推演（含 24 组参数扫描、新旧对比、9 条踩坑记录）见 docs/energy-model.md。
 */

export type EnergyConfig = {
  enabled: boolean;
  /** 上限。恒定值，不叠加基准——否则昨天满电今天能说 12 次，太夸张 */
  cap: number;
  /** 冷却地板：每天至少留一次。消耗可以跌破，冷却会把它拉回来 */
  floor: number;
  /** 高于地板时的衰减半衰期（小时） */
  halfH: number;
  /** 跌破地板后的恢复半衰期（小时）：回答扣掉的是「干活累了」，不是「额度用完」 */
  restH: number;
  /** 主动开口的成本：插话、起话头 */
  costInit: number;
  /** 醒来发现对话记录、回一句的成本。谁回答问题不耗能呢 */
  costAnswer: number;
  /** 他回一句的满额收益，再乘档位 */
  gain: number;
  /** sigmoid 中点：E 到这里时正好是热/冷的分界 */
  mid: number;
  /** sigmoid 尺度：越小越像开关，越大越像渐变 */
  scale: number;
  /** 活跃时段（小时）。睡觉的时候不掉电 */
  activeStartH: number;
  activeEndH: number;
  /** 热态最短间隔（分钟），冷态最长间隔 */
  hotMin: number;
  coldMin: number;
};

export const ENERGY_DEFAULTS: EnergyConfig = {
  enabled: true,
  cap: 8,
  floor: 1,
  halfH: 8,
  restH: 1,
  costInit: 1.0,
  costAnswer: 0.1,
  gain: 1.0,
  mid: 3.8,
  scale: 0.9,
  activeStartH: 8,
  activeEndH: 24,
  hotMin: 3,
  coldMin: 240,
};

export function energyCfg(c?: Partial<EnergyConfig> | null): EnergyConfig {
  const merged = { ...ENERGY_DEFAULTS, ...(c ?? {}) };
  merged.cap = Math.max(1, merged.cap);
  merged.floor = Math.min(merged.floor, merged.cap);
  merged.mid = Math.min(Math.max(merged.mid, 0), merged.cap);
  merged.scale = Math.max(0.05, merged.scale);
  return merged;
}

/** 回复延迟 → 档位得分。>24h 不算回复（0 分，但仍进分母） */
const BANDS: [number, number][] = [
  [1, 1.0], [5, 0.85], [10, 0.7], [20, 0.55], [30, 0.45],
  [60, 0.3], [120, 0.2], [720, 0.1], [1440, 0.03],
];

export function band(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes > 1440) return 0;
  for (const [t, s] of BANDS) if (minutes <= t) return s;
  return 0;
}

/** 隔夜结算：昨天的红蓝区间 → 今天的基准 E（1~cap） */
export function settle(replies: number[], cfg: EnergyConfig = ENERGY_DEFAULTS): number {
  const n = replies.length;
  if (n === 0) return cfg.floor;
  const p = replies.reduce((s, x) => s + band(x), 0) / n;
  const c = Math.min(1, n / 3);
  return Math.max(cfg.floor, Math.min(cfg.cap, Math.round(1 + (cfg.cap - 1) * p * c)));
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * 距上次对话多久之后可以再开口（分钟）。
 *
 * `lastWasHers`：最后一句是她说的。她说完没人接，就别追——等三倍。
 * 少了这条，热态下她说完 5 分钟又说一遍，能连着 8 次没人理。
 */
export function interval(E: number, lastWasHers: boolean, cfg: EnergyConfig = ENERGY_DEFAULTS): number {
  const s = sigmoid((E - cfg.mid) / cfg.scale);
  const base = cfg.coldMin * (1 - s) + cfg.hotMin * s;
  return lastWasHers ? base * 3 : base;
}

/** 某个小时（0~24）落在活跃时段内的分钟数 */
function activeSpan(h: number, cfg: EnergyConfig): number {
  const start = cfg.activeStartH * 60, end = cfg.activeEndH * 60;
  const t = h * 60;
  if (t <= start) return 0;              // 还早
  return Math.max(0, Math.min(t, end) - start);
}

/**
 * 冷却：从 t0 到 t1（都是「当天 0 点起的分钟」）衰减多少。
 *
 * 只算活跃时段——睡觉的时候她不在线，电量不该往下掉。这条是推演里发现的真 bug：
 * 从 0 点开始算，E=3 在没人说话的 9 小时里就冷没了，早上起床等于没有额度。
 *
 * 两段：高于地板衰减，低于地板恢复。少了恢复这一半，回答扣 0.1 会让 E 永久卡在 0.9，
 * 而主动要求 E ≥ 1 → 一次都发不出。
 */
export function cool(E: number, t0: number, t1: number, cfg: EnergyConfig = ENERGY_DEFAULTS): number {
  if (t1 <= t0) return E;
  const minutes = Math.max(0, activeSpan(t1 / 60, cfg) - activeSpan(t0 / 60, cfg));
  if (minutes <= 0) return E;
  const k = Math.pow(0.5, minutes / (cfg.halfH * 60));
  if (E > cfg.floor) return cfg.floor + (E - cfg.floor) * k;
  const back = E + (cfg.floor - E) * (1 - Math.pow(0.5, minutes / (cfg.restH * 60)));
  return cfg.floor - back < 1e-3 ? cfg.floor : back;
}

export type EnergyMsg = { ts: number; fromSelf: boolean };

export type ReplayResult = {
  E: number;
  /** 期间充了多少、耗了多少，用于观测 */
  gained: number;
  spent: number;
  replies: number[];
};

/**
 * 把 t0→t1 之间的消息按顺序应用到电量上。
 *
 * 判定「她的消息是主动还是回答」：紧跟在对方消息后面（5 分钟内）算回答，否则算主动。
 * 这条近似不做精确归因——真要知道哪句是主动开的，看 tide_events 里的 fired 记录。
 */
export function replay(
  E: number, msgs: EnergyMsg[], t0: number, t1: number, cfg: EnergyConfig = ENERGY_DEFAULTS,
): ReplayResult {
  const toMin = (ms: number) => ms / 60e3;
  let cur = cool(E, toMin(t0), toMin(t1), cfg);
  let prev: EnergyMsg | null = null;
  let gained = 0, spent = 0;
  const replies: number[] = [];

  for (const m of msgs) {
    if (m.ts <= t0 || m.ts > t1) continue;
    cur = cool(cur, prev ? toMin(prev.ts) : toMin(t0), toMin(m.ts), cfg);
    if (m.fromSelf) {
      // 连着几条是她一口气发的（10 分钟内）→ 同一轮发言，只计一次
      // 少了这条，18:57 连发 4 条会被算成 4 次主动、扣光 4 点
      const sameTurn = !!prev && prev.fromSelf && m.ts - prev.ts <= 10 * 60e3;
      if (!sameTurn) {
        // 跟在他后面 5 分钟内 = 她在回答问题；否则是她自己起的话头
        const isAnswer = prev && !prev.fromSelf && m.ts - prev.ts <= 5 * 60e3;
        const cost = isAnswer ? cfg.costAnswer : cfg.costInit;
        // 消耗不许跌破地板。曾经允许跌破再靠冷却拉回，线上实测 E 掉到 0 之后
        // 冷却只能渐近逼近 1、永远到不了，等于当天再也主动不了——地板就是「每天留一次」
        cur = Math.max(cfg.floor, cur - cost);
        spent += cost;
      }
    } else if (prev && prev.fromSelf) {
      // 红 → 蓝：他接了她的话，按区间长度充能
      const gapMin = (m.ts - prev.ts) / 60e3;
      const g = Math.min(cfg.gain * band(gapMin), Math.max(0, cfg.cap - cur));
      cur += g;
      gained += g;
      replies.push(gapMin);
    }
    prev = m;
  }
  return { E: cur, gained, spent, replies };
}

export type EnergyVerdict = {
  ok: boolean;
  E: number;
  need: number;
  idleMin: number | null;
  lastWasHers: boolean;
  detail: string;
};

/**
 * 这一刻能不能主动开口。
 * 两个条件：还有电（E ≥ 地板），以及距上次对话够久（I(E)，她说完没被回则三倍）。
 */
export function verdict(
  E: number, lastTalkTs: number | null, lastWasHers: boolean, now: number,
  cfg: EnergyConfig = ENERGY_DEFAULTS,
): EnergyVerdict {
  const idleMin = lastTalkTs === null ? null : (now - lastTalkTs) / 60e3;
  const need = interval(E, lastWasHers, cfg);
  const eTxt = `E=${E.toFixed(1)}`;
  if (E < cfg.floor) {
    return { ok: false, E, need, idleMin, lastWasHers, detail: `${eTxt} 低于地板 ${cfg.floor}：今天说完了` };
  }
  if (idleMin !== null && idleMin < need) {
    const why = lastWasHers ? '刚说完还没人回' : '刚聊过';
    return {
      ok: false, E, need, idleMin, lastWasHers,
      detail: `${eTxt}｜距上次 ${idleMin.toFixed(0)} 分钟 < ${need.toFixed(0)}（${why}）`,
    };
  }
  return {
    ok: true, E, need, idleMin, lastWasHers,
    detail: `${eTxt}｜距上次 ${idleMin === null ? '—' : idleMin.toFixed(0) + ' 分钟'} > ${need.toFixed(0)}`,
  };
}
