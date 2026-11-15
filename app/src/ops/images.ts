/** 图片索引与路径解析：宿主 API、chat（action=view）工具共用。 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../core/db.ts";
import { mediaInboxDir } from "../core/runtime.ts";
import { fmtLocal } from "../core/time.ts";
import { clampInt } from "./common.ts";

export interface ImageRoots {
  media: string[];
  inbox: string[];
}

/**
 * 图片根目录：老数据留在 data/media|inbox；新收到的图直接落到沙盒里的
 * <runtimeDir>/media/inbox（容器里 /work/media/inbox），两边都要能找到。
 */
export function imageRoots(cfg: Config): ImageRoots {
  const sandboxInbox = mediaInboxDir(cfg);
  return {
    media: [path.join(cfg.dataDir, "media"), sandboxInbox],
    inbox: [path.join(cfg.dataDir, "inbox"), sandboxInbox],
  };
}

export interface ListImagesOptions {
  source?: string;
  page?: number;
  size?: number;
  /** 额外的图片根目录；不传时只认 data/media|inbox（兼容旧调用/测试） */
  roots?: ImageRoots;
}

export function listImages(store: Store, dataDir: string, opts: ListImagesOptions = {}) {
  const page = clampInt(opts.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const size = clampInt(opts.size, 1, 50, 20);
  const src = (opts.source ?? "all").toLowerCase();
  const roots = opts.roots ?? { media: [path.join(dataDir, "media")], inbox: [path.join(dataDir, "inbox")] };
  const items: { name: string; kind: string; bytes: number; mtime: number; note?: string }[] = [];
  const seenAbs = new Set<string>();
  const inInbox = (abs: string) => roots.inbox.some((r) => abs === r || abs.startsWith(r + path.sep));

  if (src === "media" || src === "all") {
    const rows = store.db.prepare("select seq, ts, attachment from messages where attachment is not null order by seq desc limit 500").all() as any[];
    for (const r of rows) {
      let a: any;
      try { a = JSON.parse(r.attachment); } catch { continue; }
      if (!a?.path) continue;
      seenAbs.add(a.path);
      // 新图落在 /work/media/inbox，名字要按真实位置写，Agent 才能直接 read_file
      const prefix = inInbox(a.path) ? "inbox" : "media";
      items.push({ name: `${prefix}/${path.basename(a.path)}`, kind: prefix, bytes: a.bytes ?? 0, mtime: r.ts, note: `${a.width}×${a.height} 消息#${r.seq}` });
    }
  }
  if (src === "inbox" || src === "all") {
    for (const inboxDir of roots.inbox) {
      try {
        for (const e of fs.readdirSync(inboxDir, { withFileTypes: true })) {
          if (!e.isFile()) continue;
          const abs = path.join(inboxDir, e.name);
          if (seenAbs.has(abs)) continue;
          seenAbs.add(abs);
          const st = fs.statSync(abs);
          items.push({ name: `inbox/${e.name}`, kind: "inbox", bytes: st.size, mtime: st.mtimeMs });
        }
      } catch { /* 没有 inbox 就当空 */ }
    }
  }

  items.sort((a, b) => b.mtime - a.mtime);
  return {
    total: items.length,
    page,
    pages: Math.max(1, Math.ceil(items.length / size)),
    items: items.slice((page - 1) * size, page * size).map((i) => ({ ...i, local: fmtLocal(i.mtime) })),
  };
}

/** 把 media/x.jpg、inbox/x.png 或图片 id（img_xxx）解析成真实路径；越界一律拒绝。 */
export function resolveImagePath(dataDir: string, target: string, roots?: ImageRoots): string {
  if (!target) throw new Error("缺少图片路径");
  const all = roots
    ? [...new Set([...roots.inbox, ...roots.media])]
    : [path.join(dataDir, "inbox"), path.join(dataDir, "media")];
  const bare = target.replace(/^(media|inbox)[/\\]/, "");
  // 消息文本里写的是 [图片#img_xxx]；她可能直接拿 id 来 view，补上常见扩展名再找
  const cleaned = bare.replace(/^图片#?/, "").trim();
  const names = [target, bare, cleaned, `${cleaned}.jpg`, `${cleaned}.jpeg`, `${cleaned}.png`, `${cleaned}.bin`];
  for (const root of all) {
    for (const rel of names) {
      if (!rel) continue;
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) continue;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    }
  }
  throw new Error(`没有这张图：${target}（先跑 img-list 看有哪些）`);
}
