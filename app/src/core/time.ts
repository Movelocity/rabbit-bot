/** 时区工具（默认 Asia/Shanghai，UTC+8，无夏令时）。 */
const TZ = "Asia/Shanghai";

export function fmtLocal(ms: number, tz = TZ): string {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(ms));
  return p.replace(" ", " "); // "2026-10-22 11:08:00"
}
export function fmtShort(ms: number, tz = TZ): string {
  return fmtLocal(ms, tz).slice(5, 16); // "10-22 11:08"
}
export function dayKey(ms: number, tz = TZ): string {
  return fmtLocal(ms, tz).slice(0, 10);
}

/** 时区相对 UTC 的偏移（分钟），通过 Intl 计算 */
function tzOffsetMinutes(ms: number, tz: string): number {
  const s = fmtLocal(ms, tz);
  const asUtc = Date.parse(s.replace(" ", "T") + "Z");
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * 解析一次性计划时间：
 * - 带时区（Z 或 ±hh:mm）按其时区；
 * - 不带时区的本地时间（YYYY-MM-DDTHH:mm[:ss]）按 tz（Asia/Shanghai）解释。
 * 非法返回 null。
 */
export function parseIsoInTz(s: string, tz = TZ): number | null {
  const str = s.trim();
  const re = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
  const m = re.exec(str);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, zone] = m;
  const fields = [+y, +mo, +d, +h, +mi, +(se ?? 0)];
  if (fields[1] < 1 || fields[1] > 12 || fields[2] < 1 || fields[2] > 31 || fields[3] > 23 || fields[4] > 59 || fields[5] > 59) return null;
  const naiveUtc = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]);
  // 校验日期真实存在（如 02-30）
  const chk = new Date(naiveUtc);
  if (chk.getUTCDate() !== fields[2] || chk.getUTCMonth() !== fields[1] - 1) return null;
  if (zone) {
    if (zone === "Z") return naiveUtc;
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const off = sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4));
    return naiveUtc - off * 60000;
  }
  const off = tzOffsetMinutes(naiveUtc, tz);
  return naiveUtc - off * 60000;
}
