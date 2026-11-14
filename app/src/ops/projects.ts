/** 项目上下文：shared/projects/<slug>/{context.md,plan.md}；INDEX.md 只用来补标题和状态。 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { projectsDir } from "../core/runtime.ts";
import { fmtLocal } from "../core/time.ts";

export interface Project {
  slug: string;
  title: string;
  /** INDEX.md 里的状态原文；没登记就是空串 */
  status: string;
  context: string;
  plan: string;
  updated_at: number | null;
  updated_at_local: string | null;
  path: string;
}

type IndexRow = { title: string; status: string };

function assertSlug(slug: string): string {
  const s = String(slug ?? "").trim();
  if (!s || s === "." || s === ".." || /[\\/]/.test(s)) throw new Error(`非法的项目 id：${slug}`);
  return s;
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 解析 INDEX.md 的表格：| slug | 项目 | 状态 | 业务地图 | */
export function parseProjectIndex(raw: string): Map<string, IndexRow> {
  const out = new Map<string, IndexRow>();
  for (const line of String(raw ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("|")) continue;
    const cols = s.split("|").slice(1, -1).map((x) => x.trim());
    if (cols.length < 3) continue;
    if (cols[0] === "slug" || /^:?-{2,}/.test(cols[0])) continue;
    if (!cols[0]) continue;
    out.set(cols[0], { title: cols[1] ?? "", status: cols[2] ?? "" });
  }
  return out;
}

function headingTitle(raw: string): string {
  for (const line of String(raw ?? "").split("\n")) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    return m[1].trim().replace(/\s*·\s*(计划|项目上下文)\s*$/, "").trim();
  }
  return "";
}

function readProject(cfg: Config, slug: string, index: Map<string, IndexRow>): Project | null {
  const dir = path.join(projectsDir(cfg), slug);
  let stat: fs.Stats;
  try { stat = fs.statSync(dir); } catch { return null; }
  if (!stat.isDirectory()) return null;
  const contextPath = path.join(dir, "context.md");
  const planPath = path.join(dir, "plan.md");
  const context = readText(contextPath);
  const plan = readText(planPath);
  const row = index.get(slug);
  const updated = Math.max(mtime(contextPath), mtime(planPath));
  return {
    slug,
    title: row?.title || headingTitle(context) || headingTitle(plan) || slug,
    status: row?.status || "",
    context,
    plan,
    updated_at: updated || null,
    updated_at_local: updated ? fmtLocal(updated) : null,
    path: dir,
  };
}

export function listProjects(cfg: Config): Project[] {
  const dir = projectsDir(cfg);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const index = parseProjectIndex(readText(path.join(dir, "INDEX.md")));
  return names
    .map((slug) => readProject(cfg, slug, index))
    .filter((p): p is Project => p !== null)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.slug.localeCompare(b.slug));
}

export function getProject(cfg: Config, slug: string): Project | null {
  const s = assertSlug(slug);
  const index = parseProjectIndex(readText(path.join(projectsDir(cfg), "INDEX.md")));
  return readProject(cfg, s, index);
}

/** 只改 context.md / plan.md 正文；项目目录和 INDEX.md 仍由 Agent 维护。 */
export function updateProject(
  cfg: Config,
  slug: string,
  patch: { context?: unknown; plan?: unknown },
): Project {
  const s = assertSlug(slug);
  const dir = path.join(projectsDir(cfg), s);
  let stat: fs.Stats;
  try { stat = fs.statSync(dir); } catch { throw new Error(`没有项目 ${s}`); }
  if (!stat.isDirectory()) throw new Error(`没有项目 ${s}`);
  for (const [file, value] of [["context.md", patch.context], ["plan.md", patch.plan]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error(`${file} 必须是字符串`);
    fs.writeFileSync(path.join(dir, file), value, "utf8");
  }
  return getProject(cfg, s)!;
}
