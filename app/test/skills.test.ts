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
const cfg = loadConfig({ dataDir: dir, sandbox: { dir: sandbox } });

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
  const empty = loadConfig({ dataDir: dir, sandbox: { dir: path.join(dir, "nowhere") } });
  assert.deepEqual(listSkills(empty), []);
  assert.deepEqual(ensureSkillDataDirs(empty), []);
});
