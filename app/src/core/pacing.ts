/**
 * 投递节奏：她想说的话是一次想完的，但不该一次蹦出来。
 *
 * 以前 `send` 调一次发一次，模型连着调三次工具，三条就在 3 秒内落到对面——
 * 读起来像一个人憋着气说完三段话，不像聊天。
 *
 * 这里只做一件事：算出「上一条之后至少隔多久」。间隔按**上一条的长度**缩放，
 * 因为人打完一段长的会停一下，短的那句随口就接上了。
 *
 * 不按条数限制：连发十条也正常，只要每条之间有时间差（10-02 的结论）。
 */

/** 长度 → 间隔（毫秒）。锚点之间线性插值，超过 100 字按 5 秒封顶 */
const ANCHORS: [number, number][] = [
  [0, 800],    // 一两个字的「嗯」
  [10, 1500],  // 「钥匙到底弄了没啊」
  [20, 2000],
  [50, 3000],  // 一段完整的解释
  [100, 5000],
];

export const MAX_GAP_MS = 5000;

export function gapFor(prevLen: number): number {
  const n = Math.max(0, Number(prevLen) || 0);
  if (n >= ANCHORS[ANCHORS.length - 1][0]) return MAX_GAP_MS;
  for (let i = 1; i < ANCHORS.length; i++) {
    const [x1, y1] = ANCHORS[i];
    const [x0, y0] = ANCHORS[i - 1];
    if (n <= x1) return Math.round(y0 + ((n - x0) / (x1 - x0)) * (y1 - y0));
  }
  return MAX_GAP_MS;
}

/**
 * 还差多久才该发下一条。
 * elapsed 是距上一条已过去的毫秒；从没发过（lastTs=0）就立刻发。
 */
export function waitBefore(prevLen: number, lastTs: number, now: number): number {
  if (!lastTs) return 0;
  const gap = gapFor(prevLen);
  const elapsed = now - lastTs;
  return elapsed >= gap ? 0 : gap - elapsed;
}

/** 可见字数：表情标记不算字数（`[emoji:捂脸]` 打字时的停顿跟它无关） */
export function visibleLen(text: string): number {
  return String(text ?? "").replace(/\[emoji:[^\]]*\]/g, "").replace(/\s+/g, "").length;
}
