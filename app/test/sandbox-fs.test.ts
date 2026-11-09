import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSandboxFs, SandboxPathError } from "../src/core/sandbox-fs.ts";

function mk(): { fsbox: ReturnType<typeof createSandboxFs>; root: string; outside: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-sbox-"));
  const root = path.join(base, "sandbox");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "不该被读到");
  return { fsbox: createSandboxFs({ root, maxFileBytes: 1024, maxFiles: 3, maxReadChars: 100 }), root, outside };
}

test("写、读、列，父目录自动创建", () => {
  const { fsbox } = mk();
  assert.equal(fsbox.write("notes/a.md", "hello 沙盒"), Buffer.byteLength("hello 沙盒"));
  assert.equal(fsbox.read("notes/a.md"), "hello 沙盒");
  const items = fsbox.list();
  assert.deepEqual(items.map((i) => `${i.kind}:${i.path}`), ["dir:notes"]);
  assert.deepEqual(fsbox.list("notes").map((i) => i.path), ["notes/a.md"]);
});

test("绝对路径和 .. 一律拒绝", () => {
  const { fsbox } = mk();
  assert.throws(() => fsbox.read("/etc/hosts"), SandboxPathError);
  assert.throws(() => fsbox.read("../../etc/hosts"), SandboxPathError);
  assert.throws(() => fsbox.write("../escape.txt", "x"), SandboxPathError);
  assert.throws(() => fsbox.read(""), SandboxPathError);
});

test("指向根目录外的符号链接读不到", () => {
  const { fsbox, root, outside } = mk();
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  assert.throws(() => fsbox.read("link.txt"), SandboxPathError);
  fs.symlinkSync(outside, path.join(root, "linkdir"));
  assert.throws(() => fsbox.list("linkdir"), SandboxPathError);
  assert.throws(() => fsbox.write("linkdir/new.txt", "x"), SandboxPathError);
});

test("单文件大小和文件数上限生效", () => {
  const { fsbox } = mk();
  assert.throws(() => fsbox.write("big.txt", "x".repeat(2048)), SandboxPathError);
  fsbox.write("a.txt", "1");
  fsbox.write("b.txt", "2");
  fsbox.write("c.txt", "3");
  assert.throws(() => fsbox.write("d.txt", "4"), SandboxPathError);
  // 覆盖已有文件不算新增
  fsbox.write("a.txt", "改过");
  assert.equal(fsbox.read("a.txt"), "改过");
});

test("读超长文件会截断", () => {
  const { fsbox } = mk();
  fsbox.write("long.txt", "字".repeat(300));
  const got = fsbox.read("long.txt");
  assert.ok(got.startsWith("字".repeat(100)));
  assert.match(got, /已截断，共 300 字/);
});

test("可信根：登记过的软链落点能读，没登记的一律拒", () => {
  // 共享技能库里技能是软链（~/.agents/skills/ego-browser → 别处的真身）。
  // 只放开显式登记的目录，别的软链照样拒绝。
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-trust-"));
  const root = path.join(base, "sandbox");
  const lib = path.join(base, "lib");
  const realSkill = path.join(base, "elsewhere", "skill");
  const evilDir = path.join(base, "evil");
  for (const d of [root, lib, realSkill, evilDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(realSkill, "SKILL.md"), "外面的真身");
  fs.writeFileSync(path.join(evilDir, "secret.txt"), "不该读到");
  fs.symlinkSync(realSkill, path.join(lib, "ok-skill"), "dir");
  fs.symlinkSync(evilDir, path.join(lib, "bad-skill"), "dir");

  const fsbox = createSandboxFs({
    root, maxFileBytes: 4096, maxFiles: 10, maxReadChars: 200,
    overlays: { "shared-skills": lib },
    trustedRoots: [realSkill],
  });
  assert.equal(fsbox.read("shared-skills/ok-skill/SKILL.md"), "外面的真身");
  assert.throws(() => fsbox.read("shared-skills/bad-skill/secret.txt"), SandboxPathError);
});
