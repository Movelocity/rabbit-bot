/**
 * 项目体检 CLI：只读任务表，输出体检表。
 *
 * 用法：
 *   npx tsx scripts/pm-audit.ts            # 看结果
 *   npx tsx scripts/pm-audit.ts --write    # 同时落盘到 runtime/pm/audit-<date>.md
 *   npx tsx scripts/pm-audit.ts --json     # 机器可读
 *   npx tsx scripts/pm-audit.ts --db=/tmp/x.db   # 指向别的库（测试用）
 * 退出码：有红项 = 1，否则 0（方便挂 cron / 门禁）。
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { auditTasks, renderPmReport, type PmTaskRow } from "../src/core/pm.ts";

function main() {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const dbArg = args.find((a) => a.startsWith("--db="));
  const dbFile = dbArg ? dbArg.slice(5) : path.join(cfg.dataDir, "rabbit-bot.db");
  if (!fs.existsSync(dbFile)) {
    console.error(`找不到库：${dbFile}`);
    process.exit(2);
  }
  const store = new Store(dbFile);
  const rows = store.db
    .prepare(
      `SELECT id, name, goal, acceptance, status, doc_path, result, artifact, note,
              lease_until, created_at, updated_at, end_at
         FROM tasks ORDER BY id DESC LIMIT 200`,
    )
    .all() as PmTaskRow[];
  const report = auditTasks(rows, { now: Date.now() });
  const at = new Date();

  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...report, tasks: rows.length, at: at.toISOString() }, null, 2));
  } else {
    console.log(renderPmReport(report, rows, at));
  }

  if (args.includes("--write")) {
    const dir = path.join(cfg.runtimeDir, "pm");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `audit-${at.toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(file, renderPmReport(report, rows, at), "utf8");
    if (!args.includes("--json")) console.log(`已落盘：${file}`);
  }

  process.exit(report.red > 0 ? 1 : 0);
}

main();
