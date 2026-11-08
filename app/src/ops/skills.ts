/**
 * 技能的目录约定：skills/<name>/SKILL.md 是设计（进 git），skills/<name>/data/ 是运行时（不进 git）。
 * 这里只做发现和补目录，不执行任何技能代码——技能就是给模型读的文件。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

export interface SkillInfo {
  name: string;
  /** SKILL.md frontmatter 里的 description，一句话说明什么时候用 */
  description: string;
  /** 宿主绝对路径 */
  dir: string;
  /** 宿主绝对路径（skills/<name>/data） */
  dataDir: string;
  hasData: boolean;
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
export function listSkills(cfg: Config): SkillInfo[] {
  const root = skillsRoot(cfg);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith(".") && !IGNORED.has(e.name))
    .filter((e) => fs.existsSync(path.join(root, e.name, "SKILL.md")))
    .map((e) => {
      const dir = path.join(root, e.name);
      const dataDir = path.join(dir, "data");
      return {
        name: e.name,
        description: readDescription(path.join(dir, "SKILL.md")),
        dir, dataDir, hasData: fs.existsSync(dataDir),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 每个技能自带 data/：空目录不进 git，所以启动时补上。返回新建的目录。 */
export function ensureSkillDataDirs(cfg: Config): string[] {
  const created: string[] = [];
  for (const s of listSkills(cfg)) {
    if (s.hasData) continue;
    fs.mkdirSync(s.dataDir, { recursive: true });
    created.push(s.dataDir);
  }
  return created;
}
