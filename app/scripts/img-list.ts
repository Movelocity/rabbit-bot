#!/usr/bin/env node
/** 列能看的图：media/（聊天收到的）、inbox/（手动放的），从新到旧，分页。
 *  npx tsx scripts/img-list.ts [--source media|inbox|all] [--page 1] [--size 20] */
import { run, openStore, describe, str, num } from "./lib/kit.ts";
import { loadConfig } from "../src/config.ts";
import { listImages } from "../src/ops/images.ts";

describe("npx tsx scripts/img-list.ts [--source media|inbox|all] [--page 1] [--size 20]");

await run(({ flags }) => {
  const cfg = loadConfig({});
  const store = openStore(flags);
  try {
    return listImages(store, cfg.dataDir, {
      source: str(flags, "source"),
      page: num(flags, "page"),
      size: num(flags, "size"),
    });
  } finally { store.close(); }
});
