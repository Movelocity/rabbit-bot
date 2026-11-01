/** 图片索引与路径解析：宿主 API、view_image 工具共用。 */
import fs from "node:fs";
import path from "node:path";
import type { Store } from "../core/db.ts";
import { fmtLocal } from "../core/time.ts";
import { clampInt } from "./common.ts";

export interface ListImagesOptions {
  source?: string;
  page?: number;
  size?: number;
}

export function listImages(store: Store, dataDir: string, opts: ListImagesOptions = {}) {
  const page = clampInt(opts.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const size = clampInt(opts.size, 1, 50, 20);
  const src = (opts.source ?? "all").toLowerCase();
  const inboxDir = path.join(dataDir, "inbox");
  const items: { name: string; kind: string; bytes: number; mtime: number; note?: string }[] = [];

  if (src === "media" || src === "all") {
    const rows = store.db.prepare("select seq, ts, attachment from messages where attachment is not null order by seq desc limit 500").all() as any[];
    for (const r of rows) {
      let a: any;
      try { a = JSON.parse(r.attachment); } catch { continue; }
      if (!a?.path) continue;
      items.push({ name: `media/${path.basename(a.path)}`, kind: "media", bytes: a.bytes ?? 0, mtime: r.ts, note: `${a.width}×${a.height} 消息#${r.seq}` });
    }
  }
  if (src === "inbox" || src === "all") {
    try {
      for (const e of fs.readdirSync(inboxDir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        const st = fs.statSync(path.join(inboxDir, e.name));
        items.push({ name: `inbox/${e.name}`, kind: "inbox", bytes: st.size, mtime: st.mtimeMs });
      }
    } catch { /* 没有 inbox 就当空 */ }
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return {
    total: items.length,
    page,
    pages: Math.max(1, Math.ceil(items.length / size)),
    items: items.slice((page - 1) * size, page * size).map((i) => ({ ...i, local: fmtLocal(i.mtime) })),
  };
}

/** 把 media/x.jpg、inbox/x.png 解析成 data 目录下的真实路径；越界一律拒绝。 */
export function resolveImagePath(dataDir: string, target: string): string {
  if (!target) throw new Error("缺少图片路径");
  const roots = [path.join(dataDir, "inbox"), path.join(dataDir, "media")];
  const bare = target.replace(/^(media|inbox)[/\\]/, "");
  for (const root of roots) {
    for (const rel of [target, bare]) {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) continue;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    }
  }
  throw new Error(`没有这张图：${target}（先跑 img-list 看有哪些）`);
}
