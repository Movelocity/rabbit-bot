/**
 * 任务按工作目录自动归属项目（需求 R1）。
 *
 * 业务地图里的 project 对象带 source 路径（绝对路径，或仓内相对路径）。
 * 任务建好后不再依赖模型手填 `project:<slug>`：用 work_dir 对项目路径做
 * 最长前缀匹配，命中唯一项目就补进任务的业务上下文；命中多个（同长度歧义）
 * 或一个都没命中时不归因，也不报错。
 *
 * 纯函数，不依赖 store / 文件系统，方便单测和回填脚本复用。
 */

export interface ProjectPathEntry {
  /** 项目 slug（业务地图对象 id 去掉 `project:` 前缀） */
  slug: string;
  /** 该项目的路径候选（绝对路径或仓内相对路径） */
  paths: string[];
}

interface Match {
  slug: string;
  len: number;
}

/** 统一斜杠、去掉结尾多余分隔符；保留开头（判断绝对/相对要看它）。 */
function normPath(p: unknown): string {
  return String(p ?? "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/**
 * workDir 与项目路径的匹配长度；0 表示不匹配。
 * - 绝对路径：必须是 workDir 本身或以 `<src>/` 开头（路径段前缀）。
 * - 相对路径：必须按路径段出现在 workDir 里（`/src` 结尾，或 `/src/` 中间），
 *   避免 `foo-erp-gva` 误吃 `erp-gva`。
 */
function pathMatchLen(workDir: string, rawSrc: string): number {
  const src = normPath(rawSrc).replace(/^\.\//, "");
  if (!src) return 0;
  if (isAbsolutePath(src)) {
    if (workDir === src) return src.length;
    if (workDir.startsWith(`${src}/`)) return src.length;
    return 0;
  }
  if (workDir === src) return src.length;
  if (workDir.includes(`/${src}/`)) return src.length;
  if (workDir.endsWith(`/${src}`)) return src.length;
  return 0;
}

/**
 * 按 work_dir 找唯一归属的项目 slug。
 * 取匹配路径最长者；最长者若有多个不同项目（歧义）则返回 null（由调用方留空）。
 */
export function matchProjectSlugByWorkDir(
  workDir: string,
  projects: ProjectPathEntry[],
): string | null {
  const wd = normPath(workDir);
  if (!wd) return null;
  let best: Match[] = [];
  let maxLen = 0;
  for (const p of projects) {
    if (!p || !p.slug) continue;
    for (const raw of p.paths ?? []) {
      const len = pathMatchLen(wd, raw);
      if (len <= 0) continue;
      if (len > maxLen) {
        maxLen = len;
        best = [{ slug: p.slug, len }];
      } else if (len === maxLen && !best.some((b) => b.slug === p.slug)) {
        best.push({ slug: p.slug, len });
      }
    }
  }
  return best.length === 1 ? best[0].slug : null;
}

/** 从业务对象行里抽 project 对象的路径候选；兼容 DB snake_case 行和业务地图对象。 */
export function projectPathEntries(rows: Array<Record<string, any>>): ProjectPathEntry[] {
  const out: ProjectPathEntry[] = [];
  for (const row of rows) {
    if (!row) continue;
    const type = String(row.type ?? row.objectType ?? "");
    if (type !== "project") continue;
    const id = String(row.id ?? "");
    if (!id.startsWith("project:")) continue;
    const slug = id.slice("project:".length).trim();
    if (!slug || slug === "." || slug === ".." || /[\\/]/.test(slug)) continue;
    const source = (row.source ?? {}) as { kind?: string; value?: string };
    const srcKind = row.source_kind ?? source.kind;
    const srcVal = row.source_value ?? source.value;
    if (String(srcKind ?? "") !== "path" || !srcVal) continue;
    out.push({ slug, paths: [String(srcVal)] });
  }
  return out;
}
