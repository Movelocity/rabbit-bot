/**
 * 存量任务按 work_dir 回填项目归属（需求 R1）。
 *
 * 新任务在 createTask 里已自动归属；这个脚本只补历史任务：
 * 任务 context 里还没有任何 project 对象时，用 work_dir 对业务地图 project 对象的
 * source 路径做最长前缀匹配，命中唯一项目才写回。歧义/无命中一律留空。
 *
 * 用法（在 app/ 下）：
 *   npx tsx scripts/backfill-task-projects.ts            # dry-run，只打印计划
 *   npx tsx scripts/backfill-task-projects.ts --write    # 真正写回
 *   npx tsx scripts/backfill-task-projects.ts --db=/tmp/x.db
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { parseTaskContext, PROJECT_OBJECT_PREFIX, updateTask } from "../src/core/tasks.ts";
import { matchProjectSlugByWorkDir, projectPathEntries } from "../src/core/project-match.ts";

type TaskRow = { id: number; work_dir: string; context: string };

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const dbArg = args.find((a) => a.startsWith("--db="));
  const cfg = loadConfig();
  const dbFile = dbArg ? dbArg.slice("--db=".length) : path.join(cfg.dataDir, "rabbit-bot.db");
  if (!fs.existsSync(dbFile)) {
    console.error(`找不到库：${dbFile}`);
    process.exit(2);
  }

  const store = new Store(dbFile);
  const entries = projectPathEntries(store.listBusinessObjects());
  if (!entries.length) {
    console.error("业务地图里没有带 source 路径的 project 对象，回填无从谈起。先补项目对象再跑。");
    store.close();
    process.exit(2);
  }

  const rows = store.db
    .prepare("SELECT id, work_dir, context FROM tasks ORDER BY id")
    .all() as TaskRow[];

  let already = 0;
  let matched = 0;
  let skipped = 0;
  let written = 0;
  const plans: string[] = [];

  for (const row of rows) {
    const ctx = parseTaskContext(row.context);
    if (ctx.objects.some((id) => id.startsWith(PROJECT_OBJECT_PREFIX))) {
      already++;
      continue;
    }
    const wd = String(row.work_dir ?? "").trim();
    const slug = wd ? matchProjectSlugByWorkDir(wd, entries) : null;
    if (!slug) {
      skipped++;
      continue;
    }
    matched++;
    const objects = [...ctx.objects, `${PROJECT_OBJECT_PREFIX}${slug}`];
    plans.push(`#${row.id}  ${slug}  <- ${wd}`);
    if (write) {
      updateTask(store, row.id, {
        context: JSON.stringify({ objects, relations: ctx.relations, forbidden: ctx.forbidden }),
      });
      written++;
    }
  }

  console.log(`任务 ${rows.length}：已带项目 ${already}，可补 ${matched}，未命中/歧义留空 ${skipped}`);
  if (write) console.log(`已写回 ${written} 条`);
  else console.log("（dry-run，加 --write 才写回）");
  for (const line of plans.slice(0, 50)) console.log(`  ${line}`);
  if (plans.length > 50) console.log(`  … 其余 ${plans.length - 50} 条`);

  store.close();
}

main();
