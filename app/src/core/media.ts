/** 图片落盘：收到的图先压到长边 maxEdge 的 JPEG 再存，喂模型时读成 base64。 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Attachment } from "../types.ts";

export interface MediaOptions { dir: string; maxEdge: number; maxBytes: number }

/** 质量阶梯：先试高质量，超字节就往下降一档。 */
const QUALITIES = [82, 68, 55];

function sips(args: string[]): string {
  return execFileSync("sips", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function dimensions(file: string): { width: number; height: number } {
  try {
    const out = sips(["-g", "pixelWidth", "-g", "pixelHeight", file]);
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1] ?? 0);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1] ?? 0);
    return { width: w, height: h };
  } catch { return { width: 0, height: 0 }; }
}

/**
 * 压缩并落盘。长边不超过 opts.maxEdge，字节尽量不超过 opts.maxBytes。
 * sips 不可用（非 macOS / 缺命令）时原样保存，mime 标成 octet-stream，上层据此跳过喂图。
 */
export function saveImage(raw: Buffer, opts: MediaOptions, key: string): Attachment {
  fs.mkdirSync(opts.dir, { recursive: true });
  const safe = key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || String(Date.now());
  const src = path.join(opts.dir, `${safe}.src`);
  const out = path.join(opts.dir, `${safe}.jpg`);
  fs.writeFileSync(src, raw);
  let renamed = false;
  try {
    // 只缩不放：sips -Z 会顺手把小图放大，先看原尺寸
    const srcDim = dimensions(src);
    const shrink = Math.max(srcDim.width, srcDim.height) > opts.maxEdge;
    let bytes = 0;
    for (const q of QUALITIES) {
      const args = [...(shrink ? ["-Z", String(opts.maxEdge)] : []), "-s", "format", "jpeg", "-s", "formatOptions", String(q), src, "--out", out];
      sips(args);
      bytes = fs.statSync(out).size;
      if (bytes <= opts.maxBytes) break;
    }
    const { width, height } = dimensions(out);
    return { path: out, mime: "image/jpeg", width, height, bytes };
  } catch {
    const fallback = path.join(opts.dir, `${safe}.bin`);
    fs.renameSync(src, fallback);
    renamed = true;
    return { path: fallback, mime: "application/octet-stream", width: 0, height: 0, bytes: raw.length };
  } finally {
    if (!renamed) { try { fs.unlinkSync(src); } catch { /* ignore */ } }
  }
}

/** 读成 pi-ai 的 ImageContent（base64）。非图片或读失败返回 null。 */
export function toImageContent(a: Attachment): { type: "image"; data: string; mimeType: string } | null {
  try {
    if (!a.mime.startsWith("image/")) return null;
    return { type: "image", data: fs.readFileSync(a.path).toString("base64"), mimeType: a.mime };
  } catch { return null; }
}
