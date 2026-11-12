/**
 * 本地只读业务地图：和 UFA 的 map 工具同一套查询，给 WA / 运维在终端直接用。
 *
 * 用法（在 app/ 下）：
 *   npm run map -- index
 *   npm run map -- graphs
 *   npm run map -- show service:rabbit-bot-api
 *   npm run map -- resolve 松鼠鳜鱼
 *   npm run map -- path project:growthos service:erp-gva-backend
 *   npm run map -- impact project:growthos
 *   npm run map -- lint
 *
 * 只读；写地图走 GET/PUT $RB_API_BASE/v1/business，别改 runtime/business/*.json。
 */
import "../src/env-defaults.ts";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import {
  findPaths, formatPath, impactOf, loadBusinessMap, renderIndex, resolveObjects, showObject,
  type BusinessMap,
} from "../src/ops/business-map.ts";
import { lintBusinessMap } from "../src/ops/business-lint.ts";

const HELP = [
  "本地业务地图（只读）。用法：npm run map -- <action> [参数]",
  "  index                         类型 / 关系 / 对象概况",
  "  graphs                        按 graph_id 统计对象 / 关系 / 边",
  "  show <id>                     看一个对象和它的直接关系",
  "  resolve <说法>                把名字/别名解析成对象 id",
  "  path <from> <to> [depth]      两个对象之间的路径",
  "  impact <id> [depth]           改这个对象会影响谁",
  "  lint                          只读检查（悬空引用、边没证据等）",
  "  help                          看这份说明",
  "",
  "可选：--db <path> 指定 SQLite 文件（默认 app/data/rabbit-bot.db）。",
  "写地图：GET /v1/business 拿快照 → 改 → PUT /v1/business；不要改 runtime/business/*.json。",
].join("\n");

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, value === undefined ? 1 : 2);
  return value;
}

function graphCounts(map: BusinessMap): string {
  const acc = new Map<string, { objects: number; relations: number; edges: number }>();
  const row = (g: string) => acc.get(g) ?? acc.set(g, { objects: 0, relations: 0, edges: 0 }).get(g)!;
  for (const o of map.objects) row(o.graph_id || "default").objects++;
  for (const r of map.relations) row(r.graph_id || "default").relations++;
  for (const edges of map.edges.values()) for (const e of edges) row(e.graph_id || "default").edges++;
  const lines = [...acc.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([g, c]) => `${g}: ${c.objects} 对象 / ${c.relations} 关系 / ${c.edges} 边`);
  return lines.length ? lines.join("\n") : "（没有图谱）";
}

function main() {
  const args = process.argv.slice(2);
  const dbPath = takeFlag(args, "--db");
  const [cmd = "help", ...rest] = args;
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return;
  }

  const cfg = loadConfig();
  const store = new Store(dbPath || path.join(cfg.dataDir, "rabbit-bot.db"));
  try {
    if (cmd === "lint") {
      const report = lintBusinessMap(store);
      const body = report.findings.length
        ? report.findings.map((f) => `${f.level} [${f.code}] ${f.message}${f.ref ? `（${f.ref}）` : ""}`).join("\n")
        : "没有发现异常。";
      console.log(`业务地图 lint：error ${report.summary.error} / warn ${report.summary.warn} / info ${report.summary.info}`);
      if (report.counts.graphs) console.log(graphCountsFromReport(report.counts.graphs));
      console.log(body);
      return;
    }

    const map = loadBusinessMap(store);
    if (!map) {
      console.error("还没有业务地图。先用 GET/PUT $RB_API_BASE/v1/business 写入。");
      process.exitCode = 1;
      return;
    }

    switch (cmd) {
      case "index":
        console.log(renderIndex(map));
        console.log(`\n图谱：\n${graphCounts(map)}`);
        return;
      case "graphs":
        console.log(graphCounts(map));
        return;
      case "show": {
        const id = rest[0];
        if (!id) throw new Error("show 要 id");
        let view = showObject(map, id);
        if (!view) {
          const hits = resolveObjects(map, id);
          if (hits.length === 1) view = showObject(map, hits[0].object.id);
          if (!view) {
            const list = hits.map((h) => `${h.object.id}（${h.object.name}，${h.reason}）`).join("\n");
            throw new Error(hits.length ? `没有精确的 ${id}，候选：\n${list}` : `地图里没有 ${id}`);
          }
        }
        const lines = [`${view.object.id}（${view.object.name}，${view.object.type}，graph=${view.object.graph_id || "default"}）`];
        if (view.object.description) lines.push(view.object.description);
        if (view.object.aliases?.length) lines.push(`别名：${view.object.aliases.join(" / ")}`);
        for (const n of view.outgoing) {
          lines.push(`→ ${n.relationName} → ${n.other.id}（${n.other.name}）${n.risk === "high" ? " [high]" : ""}`);
        }
        for (const n of view.incoming) {
          lines.push(`← ${n.relationName} ← ${n.other.id}（${n.other.name}）${n.risk === "high" ? " [high]" : ""}`);
        }
        console.log(lines.join("\n"));
        return;
      }
      case "resolve": {
        const term = rest.join(" ").trim();
        if (!term) throw new Error("resolve 要一个说法");
        const hits = resolveObjects(map, term);
        console.log(hits.length
          ? hits.map((h) => `${h.object.id}（${h.object.name}，${h.object.type}，graph=${h.object.graph_id || "default"}；${h.reason}）`).join("\n")
          : `没找到「${term}」。用 npm run map -- index 看有哪些对象。`);
        return;
      }
      case "path": {
        const [from, to, depthRaw] = rest;
        if (!from || !to) throw new Error("path 要 from 和 to");
        const depth = depthRaw ? Number(depthRaw) : 4;
        const paths = findPaths(map, from, to, depth);
        console.log(paths.length
          ? paths.map((x) => formatPath(map, x)).join("\n")
          : `没找到 ${from} → ${to} 的路径（也可能是没数据，不是没关系）。`);
        return;
      }
      case "impact": {
        const [id, depthRaw] = rest;
        if (!id) throw new Error("impact 要 id");
        const depth = depthRaw ? Number(depthRaw) : 3;
        const hits = impactOf(map, id, depth);
        console.log(hits.length
          ? hits.map((h) => `${h.object.id}（${h.object.name}）← ${h.relation}（深度 ${h.depth}）`).join("\n")
          : `没有对象依赖 ${id}。`);
        return;
      }
      default:
        throw new Error(`没有 action=${cmd}。\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

function graphCountsFromReport(graphs: Record<string, { objects: number; relations: number; edges: number }>): string {
  return Object.entries(graphs).sort(([a], [b]) => a.localeCompare(b))
    .map(([g, c]) => `${g}: ${c.objects} 对象 / ${c.relations} 关系 / ${c.edges} 边`)
    .join("\n");
}

try {
  main();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
