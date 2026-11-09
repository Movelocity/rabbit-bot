/**
 * 技能的目录约定：skills/<name>/SKILL.md 是设计（进 git），skills/<name>/data/ 是运行时（不进 git）。
 * 这里只做发现和补目录，不执行任何技能代码——技能就是给模型读的文件。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { externalSkillsDir } from "../core/runtime.ts";

export interface SkillInfo {
  name: string;
  /** SKILL.md frontmatter 里的 description，一句话说明什么时候用 */
  description: string;
  /** 沙盒内的相对路径，read_file 直接可用：skills/<name>/SKILL.md 或 shared-skills/<name>/SKILL.md */
  path: string;
  /** 宿主绝对路径 */
  dir: string;
  /** 宿主绝对路径（skills/<name>/data）；外部技能库没有 data/，为空串 */
  dataDir: string;
  hasData: boolean;
  /** 外部技能库（shared-skills）：只读，不补 data/ */
  readonly: boolean;
}

const IGNORED = new Set(["node_modules", "data"]);

export function skillsRoot(cfg: Config): string {
  return path.join(cfg.exec.dir, "skills");
}

/**
 * 读 SKILL.md 的 frontmatter，只要 description。
 *
 * 为什么值得解析：`rb skills` 只给目录名的话，她看到的是「chat-craft」这么个词，
 * 不知道自己该不该读——技能的存在感全靠这句描述撑着。解析失败不抛错，
 * 给空字符串，技能照样可用（读正文就知道了）。
 */
function readDescription(file: string): string {
  let head: string;
  try {
    head = fs.readFileSync(file, "utf8").slice(0, 4000);
  } catch {
    return "";
  }
  const m = /^---\n([\s\S]*?)\n---/.exec(head);
  if (!m) return "";
  const fm = m[1];
  // description: 一句话 / description: >- 或 | 后面跟缩进的多行
  const inline = /^description:[ \t]*(.+)$/m.exec(fm);
  if (inline && !/^[>|][-+]?$/.test(inline[1].trim())) return inline[1].trim().replace(/^["']|["']$/g, "");
  const block = /^description:[ \t]*[>|][-+]?[ \t]*\n([\s\S]*?)(?=^\S|\z)/m.exec(fm + "\n");
  if (!block) return "";
  return block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/^["']|["']$/g, "");
}

/** 以 `_` / `.` 开头的目录不算技能（模板、临时目录）。 */
function scanRoot(root: string, prefix: string, readonly: boolean): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const e of entries) {
    if (e.name.startsWith("_") || e.name.startsWith(".") || IGNORED.has(e.name)) continue;
    const dir = path.join(root, e.name);
    // 符号链接也算：~/.agents/skills 里大半是指向别处的软链，
    // 光看 dirent.isDirectory() 会把整库漏掉。
    let st: fs.Stats;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) continue;
    const dataDir = path.join(dir, "data");
    out.push({
      name: e.name,
      description: readDescription(path.join(dir, "SKILL.md")),
      path: `${prefix}/${e.name}/SKILL.md`,
      dir,
      dataDir: readonly ? "" : dataDir,
      hasData: readonly ? true : fs.existsSync(dataDir),
      readonly,
    });
  }
  return out;
}

/**
 * 技能来自两处：自己的 skills/（可写，进 git）和外部只读库（shared-skills/）。
 * 重名时自己的那份优先——她要改就直接在工作区里放一份覆盖，不改别人的库。
 */
export function listSkills(cfg: Config): SkillInfo[] {
  const own = scanRoot(skillsRoot(cfg), "skills", false);
  const ext = externalSkillsDir(cfg);
  const seen = new Set(own.map((s) => s.name));
  const shared = ext ? scanRoot(ext, "shared-skills", true).filter((s) => !seen.has(s.name)) : [];
  return [...own, ...shared].sort((a, b) =>
    a.name === b.name ? Number(a.readonly) - Number(b.readonly) : a.name.localeCompare(b.name),
  );
}

/** 每个技能自带 data/：空目录不进 git，所以启动时补上。返回新建的目录。 */
export function ensureSkillDataDirs(cfg: Config): string[] {
  const created: string[] = [];
  for (const s of listSkills(cfg)) {
    if (s.readonly || s.hasData) continue;
    fs.mkdirSync(s.dataDir, { recursive: true });
    created.push(s.dataDir);
  }
  return created;
}
