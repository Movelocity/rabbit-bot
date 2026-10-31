/**
 * 技能的目录约定：skills/<name>/SKILL.md 是设计（进 git），skills/<name>/data/ 是运行时（不进 git）。
 * 这里只做发现和补目录，不执行任何技能代码——技能就是给模型读的文件。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";

export interface SkillInfo {
  name: string;
  /** 宿主绝对路径 */
  dir: string;
  /** 宿主绝对路径（skills/<name>/data） */
  dataDir: string;
  hasData: boolean;
}

const IGNORED = new Set(["node_modules", "data"]);

export function skillsRoot(cfg: Config): string {
  return path.join(cfg.sandbox.dir, "skills");
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
      return { name: e.name, dir, dataDir, hasData: fs.existsSync(dataDir) };
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
