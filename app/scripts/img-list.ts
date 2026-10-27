#!/usr/bin/env node
/** 列能看的图：media/（聊天收到的）、inbox/（手动放的），从新到旧，分页。
 *  npx tsx scripts/img-list.ts [--source media|inbox|all] [--page 1] [--size 20] */
import path from "node:path";
import fs from "node:fs";
import { run, openStore, describe, str, num } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";
import { fmtLocal } from "../src/core/time.ts";

describe("npx tsx scripts/img-list.ts [--source media|inbox|all] [--page 1] [--size 20]");

await run(({ flags }) => {
  const cfg = loadConfig({});
  const store = openStore(flags);
  try {
    const page = Math.max(1, Math.floor(num(flags, "page") ?? 1));
    const size = Math.min(50, Math.max(1, Math.floor(num(flags, "size") ?? 20)));
    const src = (str(flags, "source") ?? "all").toLowerCase();
    const inboxDir = path.join(cfg.dataDir, "inbox");
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
      total: items.length, page, pages: Math.max(1, Math.ceil(items.length / size)),
      items: items.slice((page - 1) * size, page * size).map((i) => ({ ...i, local: fmtLocal(i.mtime) })),
    };
  } finally { store.close(); }
});
