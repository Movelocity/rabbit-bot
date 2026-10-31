/**
 * 提示词模板：读 data/sandbox/prompt/*.md，替换 {{变量}}。
 *
 * 放在沙盒目录里是有意的：那个目录同时挂进容器当 /work，
 * 所以她在容器里用 shell 就能读、也能改自己这一份——
 * 宿主和容器看的是同一批文件，改完下一轮就生效（下面是按 mtime 缓存）。
 *
 * 刻意不做模板语言（没有 if、没有 for、没有函数）：
 * 需要分支就在代码里选哪个模板，需要列表就由代码拼成整段再注入。
 * 这样模板永远是纯文本，改文案的人不需要懂代码，也不会改坏逻辑。
 *
 * 缺变量直接抛错——静默留空会让提示词悄悄少一段，而且没人会发现。
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DIR = path.resolve(import.meta.dirname, "..", "..", "data", "sandbox", "prompt");

let dir = DEFAULT_DIR;
/** 测试用：把模板目录指到夹具上 */
export function setTemplateDir(d: string): void { dir = d; cache.clear(); }
export function templateDir(): string { return dir; }

const cache = new Map<string, { mtime: number; text: string }>();

function readTemplate(name: string): string {
  const file = path.join(dir, `${name}.md`);
  const st = fs.statSync(file); // 不存在就直接抛，别用空串糊过去
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.text;
  const text = fs.readFileSync(file, "utf8");
  cache.set(file, { mtime: st.mtimeMs, text });
  return text;
}

/** 渲染一个模板。vars 里没有的变量 → 抛错并列出缺了哪些。 */
export function render(name: string, vars: Record<string, string>): string {
  const raw = readTemplate(name);
  const missing = new Set<string>();
  const out = raw.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) { missing.add(k); return ""; }
    return vars[k];
  });
  if (missing.size) throw new Error(`模板 ${name}.md 缺少变量：${[...missing].join(", ")}`);
  return out.trim();
}

/** 模板文件清单（doctor / 文档用） */
export function listTemplates(): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  } catch { return []; }
}
