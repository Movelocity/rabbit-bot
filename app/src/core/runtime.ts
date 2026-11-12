/**
 * 运行时内容目录：人设、提示词、话题库住在这儿，代码住在仓库。
 *
 * 为什么分开：这些东西天天改，而且常常是私人的（人设是他和她的关系、话题库是他看过什么）。
 * 跟着代码一起提交，等于把私人内容推到 GitHub 上；而且每次改一句人设就多一个 commit。
 *
 * 规矩：仓库里放默认值和示例，运行时目录里放真身。有真身就用真身，没有就用仓库里的。
 * 判断只看「文件在不在」，不读配置开关——多一个开关就多一种配置错误的可能。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_ROOT, type Config } from "../config.ts";

export function runtimeDir(cfg: Config): string {
  return path.resolve(cfg.runtimeDir);
}

export function runtimePath(cfg: Config, rel: string): string {
  return path.join(runtimeDir(cfg), rel);
}

export function runtimeHas(cfg: Config, rel: string): boolean {
  try { return fs.existsSync(runtimePath(cfg, rel)); } catch { return false; }
}

/** 建目录；沙盒挂载和写文件都要它先存在 */
export function ensureRuntime(cfg: Config, subs: string[] = []): string {
  fs.mkdirSync(runtimeDir(cfg), { recursive: true });
  for (const s of subs) fs.mkdirSync(runtimePath(cfg, s), { recursive: true });
  return runtimeDir(cfg);
}

/** 话题库是可选扩展；默认关，只有显式打开才创建、挂载和提示。 */
export function topicsEnabled(cfg: Config): boolean {
  return cfg.topics?.enabled === true;
}

/**
 * 运行时内容子目录：容器里是 /work/<name>，沙盒根默认就是运行时目录。
 * 只列「内容」目录，不列 shared/ files/ 这类运行产物。
 */
export function runtimeSubdirs(cfg: Config): string[] {
  return ["prompt", ...(topicsEnabled(cfg) ? ["topics"] : []), "board"];
}

/** 沙盒根就是运行时目录时，prompt/ topics/ 已经天然在 /work 下，不用再叠加挂载。 */
export function runtimeIsSandbox(cfg: Config): boolean {
  return path.resolve(cfg.exec.dir) === runtimeDir(cfg);
}

/** worker 交汇报文件的固定落点：宿主侧 <runtimeDir>/shared，容器里 /work/shared。 */
export function sharedDir(cfg: Config): string {
  return runtimePath(cfg, "shared");
}

/** WA 通用最佳实践：固定放在 shared 根，所有任务开工前读同一份。 */
export function waPlaybookPath(cfg: Config): string {
  return path.join(sharedDir(cfg), "WA-BEST-PRACTICES.md");
}

/** WA 任务交接文档目录：shared/handoffs/task-<id>.md，后来的任务可以按关键词搜。 */
export function handoffDir(cfg: Config): string {
  return path.join(sharedDir(cfg), "handoffs");
}

/** WA 最终产出目录：shared/outputs/task-<id>/，UFA 在沙盒里直接验收。 */
export function outputsDir(cfg: Config): string {
  return path.join(sharedDir(cfg), "outputs");
}

/** 项目上下文目录：shared/projects/<slug>/，替代目标看板。 */
export function projectsDir(cfg: Config): string {
  return path.join(sharedDir(cfg), "projects");
}

/**
 * 建 shared 工作区：handoffs/ 目录 + 默认最佳实践文档。
 * 最佳实践只在缺失时落一份，之后允许运行时改，不覆盖。
 */
export function ensureSharedWorkspace(cfg: Config): string[] {
  const made: string[] = [];
  const shared = sharedDir(cfg);
  const handoffs = handoffDir(cfg);
  const outputs = outputsDir(cfg);
  const projects = projectsDir(cfg);
  try {
    if (!fs.existsSync(shared)) { fs.mkdirSync(shared, { recursive: true }); made.push(shared); }
    if (!fs.existsSync(handoffs)) { fs.mkdirSync(handoffs, { recursive: true }); made.push(handoffs); }
    if (!fs.existsSync(outputs)) { fs.mkdirSync(outputs, { recursive: true }); made.push(outputs); }
    if (!fs.existsSync(projects)) { fs.mkdirSync(projects, { recursive: true }); made.push(projects); }
  } catch { /* 建不出来就让后面的写入报错，别在这里吞掉整个启动 */ }
  const playbook = waPlaybookPath(cfg);
  if (!fs.existsSync(playbook)) {
    try {
      const src = path.join(APP_ROOT, "prompts", "wa-best-practices.md");
      fs.copyFileSync(src, playbook);
      made.push(playbook);
    } catch { /* 默认文档缺了不影响任务执行，任务文档里仍然会写路径 */ }
  }
  return made;
}

/** 收到的非图片附件落盘处：宿主侧 <runtimeDir>/files，容器里 /work/files。 */
export function filesDir(cfg: Config): string {
  return runtimePath(cfg, "files");
}

/** 业务地图：对象、关系、动作、术语表；私有数据，只放运行时目录。 */
export function businessDir(cfg: Config): string {
  return runtimePath(cfg, "business");
}

/** 计划看板：一条计划一个 md，归档在同目录 archive/ 下。 */
export function boardDir(cfg: Config): string {
  return runtimePath(cfg, "board");
}

/**
 * host 模式下把 sandbox 里这几个子目录换成指向运行时目录的软链。
 *
 * 为什么：沙盒根现在默认就是运行时目录（同一处）；只有 exec.dir 被改到别处、
 * 切到 host 以后没有挂载时，才需要把 sandbox 里的 prompt/ topics/ 接到运行时，
 * 否则 `>> topics/life/x.md` 会写进 exec.dir 里那份陈旧副本，读的是运行时、写的是副本。
 * 只有当目标不存在、或是个空目录时才动手替换，有内容就原样留着不动。
 */
export function ensureHostSandboxLinks(cfg: Config): string[] {
  const made: string[] = [];
  if (cfg.exec.shell.mode !== "host") return made;
  // 沙盒根本来就是运行时目录：prompt/ topics/ 已经在这儿，不用再指一遍（否则会自指）
  if (runtimeIsSandbox(cfg)) return made;
  for (const name of runtimeSubdirs(cfg)) {
    if (!runtimeHas(cfg, name)) continue;
    const target = runtimePath(cfg, name);
    const link = path.join(path.resolve(cfg.exec.dir), name);
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink()) {
        if (fs.readlinkSync(link) === target) continue;
        fs.unlinkSync(link); // 指错了就换掉，反正是软链
      } else if (st.isDirectory()) {
        if (fs.readdirSync(link).length > 0) continue; // 有东西就不动，避免吃掉用户的文件
        fs.rmdirSync(link);
      } else {
        continue;
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") continue;
    }
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "dir");
    made.push(`${name} -> ${target}`);
  }
  return made;
}

/**
 * 外部技能库（例如 ~/.agents/skills）：别人写的技能，她只读。
 *
 * 为什么不直接 symlink 进 skills/：sandbox-fs 明确拒绝「符号链接指向沙盒外」，
 * 挂了也读不到。走 overlay 才和 prompt/、topics/ 一样有边界（第一段命中就整条改根）。
 */
export function externalSkillsDir(cfg: Config): string | null {
  const raw = cfg.exec.sharedSkillsDir?.trim();
  if (!raw) return null;
  const abs = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : path.resolve(raw);
  try { return fs.statSync(abs).isDirectory() ? abs : null; } catch { return null; }
}

/**
 * 共享库里每个技能的真实落点。
 *
 * ~/.agents/skills 里大半是软链（ego-browser → 别处的真身）。沙盒默认拒绝
 * 「链接指向沙盒外」，所以这里把每个技能跟一遍 realpath，登记成可信根——
 * 只放开这几个目录，不是放开整个共享库外面。
 */
export function sharedSkillRoots(cfg: Config): string[] {
  const dir = externalSkillsDir(cfg);
  if (!dir) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    try {
      const real = fs.realpathSync(path.join(dir, name));
      if (fs.statSync(real).isDirectory()) out.push(real);
    } catch { /* 坏链接跳过 */ }
  }
  return out;
}

/** 需要额外挂进 /work 的目录：{ 名字 → 绝对路径 } */
export function runtimeOverlays(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  // 沙盒根不是运行时目录时，prompt/ topics/ 才需要按同名子目录挂过去；
  // 根就是运行时目录时它们已经在 /work 下，再挂一次是多余的。
  if (!runtimeIsSandbox(cfg)) {
    for (const name of runtimeSubdirs(cfg)) {
      if (runtimeHas(cfg, name)) out[name] = runtimePath(cfg, name);
    }
  }
  const ext = externalSkillsDir(cfg);
  if (ext) out["shared-skills"] = ext;
  return out;
}
