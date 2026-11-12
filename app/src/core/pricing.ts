/**
 * pricing.ts — 把一次调用拆成「缓存命中 / 未命中 / 输出」三段，并按时段算钱
 *
 * 为什么要有这个文件（2026-11-07）：
 * 之前只有两个数——原始 token（rawTokens）和折算 token（tokens = input + output +
 * cacheRead×0.1）。两个都不对得上账：
 *   · rawTokens 把「几乎免费的重读」按全价算进日额度，于是 200 万 token 的表
 *     两小时就满了，实际只花了两毛钱；
 *   · tokens 里的 0.1 是拍下来的常数，跟官方价、跟峰谷、跟模型都无关。
 *
 * 官方口径（api-docs.deepseek.com/quick_start/pricing，2026-11 抓的）：
 *   deepseek-flash   cache hit  $0.003/0.006   cache miss $0.15/0.3   out $0.6/1.2
 *   deepseek-v4-pro  cache hit  $0.022/0.044   cache miss $0.66/1.32  out $1.98/3.96
 *   （前者谷时，后者峰时；谷时正好是峰时的一半）
 *
 * 峰时 = UTC 01:00–04:00 与 06:00–10:00，周一到周五，中国法定节假日全天按谷时。
 * 换成北京时间就是 09:00–12:00、14:00–18:00 —— 跟他记的「工作日 9-12/14-18 高峰」一致。
 *
 * 节假日没法自动知道，所以留一个显式列表：config.limits.offPeakHolidays（YYYY-MM-DD）。
 * 不填就是「只有周末打折」。宁可少打一点折，也不要在峰时按谷价记账。
 */

export interface TokenSplit {
  /** 命中前缀缓存的输入 token（DeepSeek 的 prompt_cache_hit_tokens） */
  hit: number;
  /** 未命中的输入 token（prompt_tokens - 命中部分） */
  miss: number;
  /** 输出 token */
  out: number;
}

export interface ModelPrice {
  hit: { peak: number; off: number };
  miss: { peak: number; off: number };
  out: { peak: number; off: number };
}

/** 单位：美元 / 1M tokens */
export const PRICES: Record<string, ModelPrice> = {
  'deepseek-flash': {
    hit: { peak: 0.006, off: 0.003 },
    miss: { peak: 0.3, off: 0.15 },
    out: { peak: 1.2, off: 0.6 },
  },
  'deepseek-v4-flash': {
    hit: { peak: 0.006, off: 0.003 },
    miss: { peak: 0.3, off: 0.15 },
    out: { peak: 1.2, off: 0.6 },
  },
  // OpenRouter 标价，2026-11-12 抓：in $0.825 / out $4.125 / cache read $0.083（无峰谷）
  'google/gemini-3.8-flash': {
    hit: { peak: 0.083, off: 0.083 },
    miss: { peak: 0.825, off: 0.825 },
    out: { peak: 4.125, off: 4.125 },
  },
  'deepseek-v4-pro': {
    hit: { peak: 0.044, off: 0.022 },
    miss: { peak: 1.32, off: 0.66 },
    out: { peak: 3.96, off: 1.98 },
  },
};

/** 表里没有的模型：按 flash 的价算，宁可高估也不要把账做漏 */
export function priceOf(model: string): ModelPrice {
  return PRICES[model] ?? PRICES['deepseek-flash'];
}

/** 这条价格表是哪天抄的，写进日志便于事后对账 */
export const PRICE_TABLE_VERSION = '2026-11-07';

/** UTC 峰时段（左闭右开）：01–04、06–10 */
const PEAK_UTC_HOURS: Array<[number, number]> = [[1, 4], [6, 10]];

function ymdUtc(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 是不是峰时。传入毫秒时间戳；默认用「现在」。
 * holidays 用 UTC 日期比：节假日整天按谷时，不做跨时区拆分——一天之内错开的那几小时
 * 比起「把峰时当谷时少算一半」要安全得多。
 */
export function isPeakHour(atMs: number = Date.now(), holidays: string[] = []): boolean {
  const d = new Date(atMs);
  const wd = d.getUTCDay(); // 0=周日 6=周六
  if (wd === 0 || wd === 6) return false;
  if (holidays.includes(ymdUtc(atMs))) return false;
  const h = d.getUTCHours();
  return PEAK_UTC_HOURS.some(([a, b]) => h >= a && h < b);
}

/** 按官方单价算一次调用花了多少美元 */
export function costUsd(model: string, split: TokenSplit, atMs: number = Date.now(), holidays: string[] = []): number {
  const p = priceOf(model);
  const peak = isPeakHour(atMs, holidays);
  const rate = (x: { peak: number; off: number }) => (peak ? x.peak : x.off);
  return (
    (Math.max(0, split.hit) / 1e6) * rate(p.hit) +
    (Math.max(0, split.miss) / 1e6) * rate(p.miss) +
    (Math.max(0, split.out) / 1e6) * rate(p.out)
  );
}

/**
 * 把 pi 报的 usage 拆成三段。
 *
 * pi/DeepSeek 报的是：input = 未命中（cache miss）、cacheRead = 命中（cache hit）、
 * output = 输出，且 totalTokens = input + output + cacheRead + cacheWrite。
 * 用真实 session 核对过：input=279 / cacheRead=43008 / output=52 / total=43339。
 * 所以命中直接用 cacheRead，未命中直接用 input（cacheWrite 并入 miss，避免丢 token）。
 */
export function splitUsage(u: any): TokenSplit {
  const miss = (Number(u?.input ?? 0) || 0) + (Number(u?.cacheWrite ?? 0) || 0);
  const hit = Number(u?.cacheRead ?? 0) || 0;
  const out = Number(u?.output ?? 0) || 0;
  return { hit, miss, out };
}

/** 缓存命中率（按输入 token 算），用来判断「上下文到底有没有被判重」 */
export function hitRate(t: { hit: number; miss: number }): number {
  const total = t.hit + t.miss;
  return total > 0 ? t.hit / total : 0;
}
