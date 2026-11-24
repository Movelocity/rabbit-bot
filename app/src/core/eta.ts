/** 任务预估耗时：解析人写的时长，统一成毫秒。 */

/**
 * 解析预估耗时，返回毫秒。
 * - 数字 / 纯数字字符串：按分钟（"预计 30" 就是 30 分钟）
 * - 带单位：30s / 30m / 2h / 30分钟 / 1小时 / 90ms
 * - 空值：undefined
 * - 看不懂：null
 */
export function parseEtaMs(v: unknown): number | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Math.max(0, Math.round(v * 60_000));
  }
  const s = String(v).trim();
  if (!s) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.max(0, Math.round(Number(s) * 60_000));
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|秒|m|min|分钟|分|h|hr|小时|时)$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const factor = unit === "ms" ? 1
    : ["s", "sec", "秒"].includes(unit) ? 1000
      : ["h", "hr", "小时", "时"].includes(unit) ? 3600_000
        : 60_000;
  return Math.max(0, Math.round(n * factor));
}

/** 把毫秒说成人话（用于提醒语），分钟级取整。 */
export function formatEta(ms: number): string {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 60_000) return `${Math.max(1, Math.round(n / 1000))} 秒`;
  if (n < 3600_000) return `${Math.round(n / 60_000)} 分钟`;
  const h = Math.floor(n / 3600_000);
  const rest = Math.round((n % 3600_000) / 60_000);
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}
