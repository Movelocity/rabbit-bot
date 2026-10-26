/**
 * 聊天活跃度（idle）：他在这个时段有多大可能回话。
 *
 * 名字故意不叫「空闲概率」——我们只有聊天这一路信号，
 * 看不到 App 前台、读不到日历。开会秒回、下班刷着不回，这套都判不出来。
 * 它能回答的只是「这个点跟他说，他大概会不会接」，不是「他此刻有没有空」。
 *
 * 特征（全部来自 messages）：
 * - 中位回复时延：她发完 → 他下一条消息的间隔
 * - 已读未回率：她发的消息里，30 分钟内没被回的比例
 * - 主动发起率：他这条消息离上一条超过 30 分钟（是他开的口）
 *
 * 归一化用他自己的分位数（p25 / p75），不用绝对秒数——有人天生回得慢。
 * 模型只是「按小时的直方图 + 平滑」，不做 GBDT：
 * 没有「真实空闲」的监督信号，唯一的标签是「他回没回」，而那正是要预测的东西。
 */
import { localDay } from "./tide.ts";
import type { Store } from "./db.ts";

export interface IdleBucket {
  /** 小时 0~23 */
  h: number;
  /** 该时段他的消息数 */
  n: number;
  /** 中位回复时延（ms），样本不足为 null */
  medianDelay: number | null;
  /** 已读未回率 0~1 */
  unansweredRate: number | null;
  /** 主动发起率 0~1 */
  initiative: number | null;
  /** 活跃分 0~1（越高越可能回话） */
  score: number;
}

export interface IdleModel {
  day: string;
  /** 他发了多少条消息 */
  samples: number;
  /** 覆盖了多少天 */
  days: number;
  confidence: "low" | "mid";
  /** 全局分位数（ms），用于判断「对他来说算快还是慢」 */
  p25: number | null;
  p75: number | null;
  buckets: IdleBucket[];
  computedAt: number;
}

export interface IdleOptions {
  /** 回看窗口，默认 90 天 */
  lookbackMs?: number;
  /** 判定「已读未回」的窗口，默认 30 分钟 */
  replyWindowMs?: number;
  /** 切换个性化的门槛 */
  minDays?: number;
  minSamples?: number;
}

const HOUR = 3600_000;
const DEFAULTS = { lookbackMs: 90 * 24 * HOUR, replyWindowMs: 30 * 60_000, minDays: 7, minSamples: 80 };

/** 默认曲线（冷启动 / 样本不足时用）：只认「大概什么时候醒着」 */
function defaultScore(h: number, dow: number): number {
  const weekend = dow === 0 || dow === 6;
  if (h >= 1 && h <= 6) return 0.05;
  if (h >= 7 && h <= 8) return 0.35;
  if (h >= 9 && h <= 11) return weekend ? 0.6 : 0.45;
  if (h >= 12 && h <= 13) return 0.7;
  if (h >= 14 && h <= 17) return weekend ? 0.7 : 0.5;
  if (h >= 18 && h <= 22) return 0.85;
  if (h === 23) return 0.5;
  return 0.3; // 0 点
}

function hourIn(ts: number, tz: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date(ts)));
}

function dowIn(ts: number, tz: string): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ts));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(s);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? a[lo] : Math.round(a[lo] + (a[hi] - a[lo]) * (pos - lo));
}

export function computeIdle(store: Store, now: number, tz = "Asia/Shanghai", opts: IdleOptions = {}): IdleModel {
  const o = { ...DEFAULTS, ...opts };
  const msgs = store.messagesForIdle(now - o.lookbackMs);

  // 逐条扫一遍，按「消息所属小时」收集样本
  const perHour: { delays: number[]; unanswered: number[]; initiators: number[] }[] =
    Array.from({ length: 24 }, () => ({ delays: [], unanswered: [], initiators: [] }));
  const allDelays: number[] = [];
  const days = new Set<string>();
  let samples = 0;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const h = hourIn(m.ts, tz);
    if (m.from_self) {
      // 她发的话：看 30 分钟内有没有被回
      const next = msgs.slice(i + 1).find((x) => !x.from_self);
      const answered = next !== undefined && next.ts - m.ts <= o.replyWindowMs;
      // 只看最近的消息，避免「刚发出去还没回」被算成未回
      if (now - m.ts >= o.replyWindowMs) perHour[h].unanswered.push(answered ? 0 : 1);
      continue;
    }
    samples += 1;
    days.add(localDay(m.ts, tz));
    // 他发的话：与「她上一条」的间隔 = 他的反应时延
    let prevSelf: { ts: number } | undefined;
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].from_self) { prevSelf = msgs[j]; break; }
    }
    if (prevSelf && m.ts - prevSelf.ts <= 6 * HOUR) {
      const d = m.ts - prevSelf.ts;
      perHour[h].delays.push(d);
      allDelays.push(d);
    }
    // 离上一条消息超过 30 分钟 = 是他开的口
    const prev = msgs[i - 1];
    perHour[h].initiators.push(!prev || m.ts - prev.ts > o.replyWindowMs ? 1 : 0);
  }

  const p25 = quantile(allDelays, 0.25);
  const p75 = quantile(allDelays, 0.75);
  const enough = days.size >= o.minDays && samples >= o.minSamples;

  const raw: number[] = [];
  for (let h = 0; h < 24; h++) {
    const b = perHour[h];
    if (!enough || !b.delays.length) { raw.push(NaN); continue; }
    const med = median(b.delays)!;
    // 时延落在 p25~p75 之间做线性映射：越快越闲
    let s: number;
    if (p25 === null || p75 === null || p75 <= p25) s = 0.5;
    else if (med <= p25) s = 1;
    else if (med >= p75) s = 0;
    else s = 1 - (med - p25) / (p75 - p25);
    // 已读不回拉低活跃度
    if (b.unanswered.length) {
      const rate = b.unanswered.reduce((a, x) => a + x, 0) / b.unanswered.length;
      s -= rate * 0.3;
    }
    raw.push(Math.min(1, Math.max(0, s)));
  }

  // 平滑：相邻小时各占 0.25；缺数据的桶由邻居补
  const buckets: IdleBucket[] = [];
  for (let h = 0; h < 24; h++) {
    const b = perHour[h];
    const prev = raw[(h + 23) % 24];
    const next = raw[(h + 1) % 24];
    const selfRaw = raw[h];
    let score: number;
    if (Number.isNaN(selfRaw)) {
      const nb = [prev, next].filter((x) => !Number.isNaN(x)) as number[];
      score = nb.length ? nb.reduce((a, x) => a + x, 0) / nb.length : defaultScore(h, dowIn(now, tz));
    } else {
      const ps = Number.isNaN(prev) ? selfRaw : prev;
      const ns = Number.isNaN(next) ? selfRaw : next;
      score = 0.5 * selfRaw + 0.25 * ps + 0.25 * ns;
    }
    buckets.push({
      h,
      n: b.delays.length + b.unanswered.length,
      medianDelay: enough ? median(b.delays) : null,
      unansweredRate: b.unanswered.length ? b.unanswered.reduce((a, x) => a + x, 0) / b.unanswered.length : null,
      initiative: b.initiators.length ? b.initiators.reduce((a, x) => a + x, 0) / b.initiators.length : null,
      score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    });
  }

  return {
    day: localDay(now, tz),
    samples,
    days: days.size,
    confidence: enough ? "mid" : "low",
    p25, p75, buckets, computedAt: now,
  };
}

/**
 * 此刻的活跃度 0~1。
 * - 样本不足：一律 0.5（不放大、也不拦）
 * - 30 分钟内有互动：直接给 1（当前活跃是最强的证据，不需要样本）
 */
