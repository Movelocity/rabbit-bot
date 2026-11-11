/**
 * 计划看板：一条计划一个 md，md 是唯一真相，不落库。
 *
 * 结构（人可读、模型也能直接读写）：
 *
 *   # 标题
 *   - 状态: active
 *   - 创建: 2026-11-11 14:30:00
 *   - 更新: 2026-11-11 15:02:00
 *   - 池: p1
 *   - 标签: 发布, 排查
 *
 *   ## 背景
 *   为什么做、范围、约束、相关链接。
 *
 *   ## 目标
 *   - [ ] 1.1 ...
 *   - [x] 1.2 ...
 *
 *   ## 进展
 *   - 2026-11-11 15:02 做了...
 *
 * 目录：<runtimeDir>/board/<slug>.md，归档到 <runtimeDir>/board/archive/<日期>-<slug>.md。
 * 参考 openspec 的 change 文件夹，但只保留背景 / 目标 / 进展，不做 delta spec 合并。
 */
import fs from "node:fs";
import path from "node:path";
import { fmtLocal, parseIsoInTz } from "./time.ts";

export type BoardStatus = "active" | "done" | "archived";
export const BOARD_STATUSES: BoardStatus[] = ["active", "done", "archived"];

export interface BoardGoal {
  /** 原文（含编号），勾选时原样写回 */
  text: string;
  done: boolean;
}

export interface BoardProgress {
  /** 行首时间；没写就是 null */
  at: number | null;
  text: string;
}

export interface Board {
  slug: string;
  title: string;
  status: BoardStatus;
  createdAt: number | null;
  updatedAt: number | null;
  pool: string | null;
  tags: string[];
  background: string;
  goals: BoardGoal[];
  progress: BoardProgress[];
  path: string;
}

export interface CreateBoardInput {
  title: string;
  background?: string;
  goals?: string[];
  pool?: string | null;
  tags?: string[];
  status?: BoardStatus;
}

export interface BoardSummary {
  slug: string;
  title: string;
  status: BoardStatus;
  createdAt: number | null;
  updatedAt: number | null;
  pool: string | null;
  tags: string[];
  goalsTotal: number;
  goalsDone: number;
  progressCount: number;
  background: string;
}

const STATUS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/;
const GOAL_RE = /^\s*-\s*\[( |x|X)\]\s*(.*)$/;
const META_RE = /^\s*-\s*(状态|创建|更新|池|标签|status|created|updated|pool|tags)\s*[:：]\s*(.*)$/;

function parseTime(s: string): number | null {
  const m = STATUS_RE.exec(s.trim());
  if (!m) return null;
  return parseIsoInTz(`${m[1]}T${m[2]}:${m[3] ?? "00"}`, "Asia/Shanghai");
}

function asStatus(v: string | undefined): BoardStatus {
  const s = String(v ?? "").trim().toLowerCase();
  return (BOARD_STATUSES as string[]).includes(s) ? (s as BoardStatus) : "active";
}

/** 从标题生成文件名：保留中英文和数字，其余压成 -，避免路径穿越。 */
export function slugify(title: string): string {
  const s = String(title ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return s || "plan";
}

function assertSlug(slug: string): string {
  const s = String(slug ?? "").trim();
  if (!s || s === "." || s === ".." || /[\\/]/.test(s)) throw new Error(`非法的计划 id：${slug}`);
  return s;
}

function uniqueSlug(dir: string, base: string): string {
  let slug = base;
  for (let i = 2; fs.existsSync(path.join(dir, `${slug}.md`)); i++) slug = `${base}-${i}`;
  return slug;
}

export function parseBoard(slug: string, raw: string, filePath = ""): Board {
  const lines = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n");
  let title = slug;
  let status: BoardStatus = "active";
  let createdAt: number | null = null;
  let updatedAt: number | null = null;
  let pool: string | null = null;
  let tags: string[] = [];
  const background: string[] = [];
  const goals: BoardGoal[] = [];
  const progress: BoardProgress[] = [];
  let section: "meta" | "background" | "goals" | "progress" | "other" = "meta";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, "").trim() || slug; continue; }
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      const name = h[1].trim().toLowerCase();
      if (name === "背景" || name === "background") section = "background";
      else if (name === "目标" || name === "goals") section = "goals";
      else if (name === "进展" || name === "progress") section = "progress";
      else section = "other";
      continue;
    }
    if (section === "meta") {
      const m = META_RE.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "状态" || key === "status") status = asStatus(val);
      else if (key === "创建" || key === "created") createdAt = parseTime(val);
      else if (key === "更新" || key === "updated") updatedAt = parseTime(val);
      else if (key === "池" || key === "pool") pool = val || null;
      else if (key === "标签" || key === "tags") tags = val.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      continue;
    }
    if (section === "background") {
      background.push(line);
      continue;
    }
    if (section === "goals") {
      const g = GOAL_RE.exec(line);
      if (g) goals.push({ done: g[1].toLowerCase() === "x", text: g[2].trim() });
      continue;
    }
    if (section === "progress") {
      if (!/^\s*-\s+/.test(line)) continue;
      const body = line.replace(/^\s*-\s+/, "").trim();
      if (!body) continue;
      const tm = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?\s+(.*)$/.exec(body);
      if (tm) {
        progress.push({
          at: parseIsoInTz(`${tm[1]}T${tm[2]}:${tm[3] ?? "00"}`, "Asia/Shanghai"),
          text: tm[4].trim(),
        });
      } else {
        progress.push({ at: null, text: body });
      }
    }
  }

  return {
    slug,
    title,
    status,
    createdAt,
    updatedAt,
    pool,
    tags,
    background: trimBlank(background).join("\n").trim(),
    goals,
    progress,
    path: filePath,
  };
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

export function renderBoard(b: Board): string {
  const meta = [
    `- 状态: ${b.status}`,
    b.createdAt !== null ? `- 创建: ${fmtLocal(b.createdAt)}` : "",
    b.updatedAt !== null ? `- 更新: ${fmtLocal(b.updatedAt)}` : "",
    b.pool ? `- 池: ${b.pool}` : "",
    b.tags.length ? `- 标签: ${b.tags.join(", ")}` : "",
  ].filter(Boolean);
  const goals = b.goals.map((g) => `- [${g.done ? "x" : " "}] ${g.text}`);
  const progress = b.progress.map((p) => `- ${p.at !== null ? `${fmtLocal(p.at)} ` : ""}${p.text}`);
  return [
    `# ${b.title}`,
    "",
    ...meta,
    "",
    "## 背景",
    "",
    b.background.trim() || "（还没写背景）",
    "",
    "## 目标",
    "",
    ...(goals.length ? goals : ["（还没列目标）"]),
    "",
    "## 进展",
    "",
    ...(progress.length ? progress : ["- （暂无进展）"]),
    "",
  ].join("\n");
}

function readRaw(dir: string, slug: string): { b: Board } | null {
  const s = assertSlug(slug);
  const file = path.join(dir, `${s}.md`);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  return { b: parseBoard(s, raw, file) };
}

export function listBoards(dir: string, status?: BoardStatus | "all"): Board[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("."));
  } catch {
    return [];
  }
  const out: Board[] = [];
  for (const name of names) {
    const slug = name.replace(/\.md$/, "");
    const hit = readRaw(dir, slug);
    if (!hit) continue;
    if (status && status !== "all" && hit.b.status !== status) continue;
    out.push(hit.b);
  }
  // 手改过的文件按 mtime 排，避免 md 里没写更新时间就永远沉底
  return out.sort((a, b) => mtime(b.path) - mtime(a.path) || a.slug.localeCompare(b.slug));
}

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

export function getBoard(dir: string, slug: string): Board | null {
  return readRaw(dir, slug)?.b ?? null;
}

export function createBoard(dir: string, input: CreateBoardInput, now = Date.now()): Board {
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("计划要有标题");
  fs.mkdirSync(dir, { recursive: true });
  const slug = uniqueSlug(dir, slugify(title));
  const b: Board = {
    slug,
    title,
    status: input.status && input.status !== "archived" ? input.status : "active",
    createdAt: now,
    updatedAt: now,
    pool: input.pool ?? null,
    tags: (input.tags ?? []).map((x) => String(x).trim()).filter(Boolean),
    background: String(input.background ?? "").trim(),
    goals: (input.goals ?? []).map((g) => ({ done: false, text: String(g).trim() })).filter((g) => g.text),
    progress: [],
    path: path.join(dir, `${slug}.md`),
  };
  fs.writeFileSync(b.path, renderBoard(b), "utf8");
  return b;
}

export function saveBoard(dir: string, b: Board, now = Date.now()): Board {
  b.updatedAt = now;
  b.path = path.join(dir, `${assertSlug(b.slug)}.md`);
  fs.mkdirSync(path.dirname(b.path), { recursive: true });
  fs.writeFileSync(b.path, renderBoard(b), "utf8");
  return b;
}

export function updateBoard(dir: string, slug: string, patch: { background?: string; status?: BoardStatus; tags?: string[] }, now = Date.now()): Board {
  const b = getBoard(dir, slug);
  if (!b) throw new Error(`没有计划 ${slug}`);
  if (patch.background !== undefined) b.background = String(patch.background).trim();
  if (patch.status !== undefined) b.status = patch.status;
  if (patch.tags !== undefined) b.tags = patch.tags.map((x) => String(x).trim()).filter(Boolean);
  return saveBoard(dir, b, now);
}

export function addGoals(dir: string, slug: string, goals: string[], now = Date.now()): Board {
  const b = getBoard(dir, slug);
  if (!b) throw new Error(`没有计划 ${slug}`);
  for (const g of goals.map((x) => String(x).trim()).filter(Boolean)) b.goals.push({ done: false, text: g });
  return saveBoard(dir, b, now);
}

/**
 * 勾选目标。goal 传 1 开始的序号，或目标文字的一部分。
 * 找不到 / 命中多条都报错，别悄悄勾错一个。
 */
export function checkGoal(dir: string, slug: string, goal: string | number, done = true, now = Date.now()): Board {
  const b = getBoard(dir, slug);
  if (!b) throw new Error(`没有计划 ${slug}`);
  let idx = -1;
  if (typeof goal === "number" || /^\d+$/.test(String(goal).trim())) {
    idx = Number(goal) - 1;
  } else {
    const q = String(goal).trim();
    const hits = b.goals.map((g, i) => ({ g, i })).filter(({ g }) => g.text.includes(q));
    if (hits.length > 1) throw new Error(`「${q}」命中 ${hits.length} 条目标，给序号更准：${hits.map((h) => h.i + 1).join(", ")}`);
    if (hits.length === 1) idx = hits[0].i;
  }
  if (idx < 0 || idx >= b.goals.length) throw new Error(`没有第 ${goal} 条目标`);
  b.goals[idx].done = done;
  return saveBoard(dir, b, now);
}

export function addProgress(dir: string, slug: string, note: string, now = Date.now()): Board {
  const b = getBoard(dir, slug);
  if (!b) throw new Error(`没有计划 ${slug}`);
  const text = String(note ?? "").trim();
  if (!text) throw new Error("进展不能为空");
  b.progress.push({ at: now, text });
  return saveBoard(dir, b, now);
}

export function archiveBoard(dir: string, slug: string, now = Date.now()): Board {
  const b = getBoard(dir, slug);
  if (!b) throw new Error(`没有计划 ${slug}`);
  b.status = "archived";
  b.updatedAt = now;
  const archiveDir = path.join(dir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const name = `${fmtLocal(now).slice(0, 10)}-${b.slug}.md`;
  const target = path.join(archiveDir, name);
  fs.writeFileSync(target, renderBoard(b), "utf8");
  try { fs.unlinkSync(b.path); } catch { /* 已经不在了也算完成 */ }
  b.path = target;
  return b;
}

export function summarize(b: Board): BoardSummary {
  return {
    slug: b.slug,
    title: b.title,
    status: b.status,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    pool: b.pool,
    tags: b.tags,
    goalsTotal: b.goals.length,
    goalsDone: b.goals.filter((g) => g.done).length,
    progressCount: b.progress.length,
    background: b.background.slice(0, 400),
  };
}
