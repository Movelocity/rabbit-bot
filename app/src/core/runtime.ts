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
import path from "node:path";
import type { Config } from "../config.ts";

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

/**
 * 可以从运行时目录覆盖的沙盒子目录：容器里是 /work/<name>，
 * 宿主侧 read_file 的根也在 data/sandbox，两处都要先看运行时目录。
 * 只列「内容」目录，不列 files/ data/ 这类运行产物。
 */
export const RUNTIME_SUBDIRS = ["prompt", "topics"] as const;

/**
 * host 模式下把 sandbox 里这几个子目录换成指向运行时目录的软链。
 *
 * 为什么：容器模式靠 volume 挂载让 /work/topics 等于运行时话题库；
 * 切到 host 以后没有挂载，`>> topics/life/x.md` 会写进 data/sandbox 里那份陈旧副本，
 * 读的是运行时、写的是副本——一份内容两个地方，最难受的就是这种分叉。
 * 只有当目标不存在、或是个空目录时才动手替换，有内容就原样留着不动。
 */
export function ensureHostSandboxLinks(cfg: Config): string[] {
  const made: string[] = [];
  if (cfg.exec.shell.mode !== "host") return made;
  for (const name of RUNTIME_SUBDIRS) {
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

/** 有真身的那些子目录：{ 名字 → 绝对路径 } */
export function runtimeOverlays(cfg: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of RUNTIME_SUBDIRS) {
    if (runtimeHas(cfg, name)) out[name] = runtimePath(cfg, name);
  }
  return out;
}
