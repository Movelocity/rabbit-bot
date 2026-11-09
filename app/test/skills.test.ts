/** 技能目录约定：SKILL.md 是设计，data/ 是运行时；模板/无 SKILL.md 的目录不算技能。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ensureSkillDataDirs, listSkills } from "../src/ops/skills.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-skills-"));
const sandbox = path.join(dir, "sandbox");
const skills = path.join(sandbox, "skills");
// 显式关掉外部技能库：单测会合并线上 local.json，否则会读到机器上真实的 ~/.agents/skills
const cfg = loadConfig({ dataDir: dir, exec: { dir: sandbox, sharedSkillsDir: "" } });

const mk = (name: string, withSkill = true) => {
  const d = path.join(skills, name);
  fs.mkdirSync(d, { recursive: true });
  if (withSkill) fs.writeFileSync(path.join(d, "SKILL.md"), `# ${name}\n`);
  return d;
};

test.before(() => {
  mk("demo");
  mk("another");
  mk("_template");
  mk("not-a-skill", false);
  fs.mkdirSync(path.join(skills, "demo", "data"), { recursive: true });
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("只认有 SKILL.md 的目录，模板（_ 开头）和无 SKILL.md 的不算", () => {
  assert.deepEqual(listSkills(cfg).map((s) => s.name), ["another", "demo"]);
});

test("hasData 反映现状", () => {
  const byName = Object.fromEntries(listSkills(cfg).map((s) => [s.name, s]));
  assert.equal(byName.demo.hasData, true);
  assert.equal(byName.another.hasData, false);
});

test("ensureSkillDataDirs 只补缺的，重复调用不再新建", () => {
  const created = ensureSkillDataDirs(cfg);
  assert.deepEqual(created.map((p) => path.relative(skills, p)), ["another/data"]);
  assert.equal(fs.existsSync(path.join(skills, "another", "data")), true);
  assert.deepEqual(ensureSkillDataDirs(cfg), []);
});

test("没有 skills 目录时返回空，不抛错", () => {
  const empty = loadConfig({ dataDir: dir, exec: { dir: path.join(dir, "nowhere"), sharedSkillsDir: "" } });
  assert.deepEqual(listSkills(empty), []);
  assert.deepEqual(ensureSkillDataDirs(empty), []);
});

test("外部技能库：只读、跟软链、重名以本地为准、不补 data/", () => {
  // ~/.agents/skills 那种库：别人写的技能，只读；里面大半是指向别处的软链。
  const ext = path.join(dir, "ext-skills");
  const real = path.join(dir, "ext-real", "linked-one");
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, "SKILL.md"), "---\nname: linked-one\ndescription: 软链进来的技能\n---\n");
  fs.mkdirSync(path.join(ext, "shared-one"), { recursive: true });
  fs.writeFileSync(path.join(ext, "shared-one", "SKILL.md"), "---\nname: shared-one\ndescription: 外面写的技能\n---\n");
  fs.symlinkSync(real, path.join(ext, "linked-one"), "dir");
  // 同名的本地技能：她可以放一份覆盖，不改别人的库
  mk("shared-one");

  const c2 = loadConfig({ dataDir: dir, exec: { dir: sandbox, sharedSkillsDir: ext } });
  const by = Object.fromEntries(listSkills(c2).map((s) => [s.name, s]));

  assert.equal(by["linked-one"]?.readonly, true, "符号链接目录要算技能");
  assert.equal(by["linked-one"].path, "shared-skills/linked-one/SKILL.md");
  assert.equal(by["linked-one"].description, "软链进来的技能", "软链也要读到 description");
  assert.equal(by["shared-one"].readonly, false, "重名时本地那份优先");
  assert.equal(by["shared-one"].path, "skills/shared-one/SKILL.md");

  ensureSkillDataDirs(c2);
  assert.equal(fs.existsSync(path.join(ext, "linked-one", "data")), false, "外部库不补 data/");
});
