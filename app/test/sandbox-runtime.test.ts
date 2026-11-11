/** 沙盒根 = 运行时目录；worker 汇报落在 runtime/shared。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { runtimeOverlays, sharedDir, filesDir, runtimeIsSandbox } from "../src/core/runtime.ts";
import { renderTaskDoc } from "../src/core/dispatch.ts";

function cfgFor(dir: string, extra: Record<string, unknown> = {}) {
  return loadConfig({
    runtimeDir: dir,
    exec: { dir: "", sharedSkillsDir: "", shell: { mode: "host", volumes: [{ host: "", container: "/work", mode: "rw" }] } },
    ...extra,
  });
}

test("exec.dir 留空 = 跟随 runtimeDir，volumes 的 host 也跟着走", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-rt-"));
  const cfg = cfgFor(dir);
  assert.equal(cfg.exec.dir, path.resolve(dir));
  assert.equal(cfg.exec.shell.volumes[0].host, path.resolve(dir));
  assert.equal(runtimeIsSandbox(cfg), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("沙盒根就是运行时目录时不再叠加 prompt/topics 挂载", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-rt-"));
  fs.mkdirSync(path.join(dir, "prompt"), { recursive: true });
  fs.mkdirSync(path.join(dir, "topics"), { recursive: true });
  const cfg = cfgFor(dir);
  assert.deepEqual(runtimeOverlays(cfg), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("沙盒根不是运行时目录时，prompt/topics 仍按同名子目录 overlay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-rt-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "rb-sbx-"));
  fs.mkdirSync(path.join(dir, "prompt"), { recursive: true });
  fs.mkdirSync(path.join(dir, "topics"), { recursive: true });
  const cfg = loadConfig({
    runtimeDir: dir,
    topics: { enabled: true },
    exec: { dir: other, sharedSkillsDir: "", shell: { mode: "host" } },
  });
  assert.deepEqual(runtimeOverlays(cfg), {
    prompt: path.join(dir, "prompt"),
    topics: path.join(dir, "topics"),
  });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test("话题库默认关闭：即使目录存在也不 overlay", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-rt-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "rb-sbx-"));
  fs.mkdirSync(path.join(dir, "prompt"), { recursive: true });
  fs.mkdirSync(path.join(dir, "topics"), { recursive: true });
  const cfg = loadConfig({
    runtimeDir: dir,
    exec: { dir: other, sharedSkillsDir: "", shell: { mode: "host" } },
  });
  assert.deepEqual(runtimeOverlays(cfg), { prompt: path.join(dir, "prompt") });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});

test("shared/files 固定落在运行时目录下", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-rt-"));
  const cfg = cfgFor(dir);
  assert.equal(sharedDir(cfg), path.join(dir, "shared"));
  assert.equal(filesDir(cfg), path.join(dir, "files"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("任务文档带汇报文件落点", () => {
  const shared = "/tmp/rb-runtime/shared";
  const task = {
    id: 7, name: "#demo", goal: "做点事", deliverable: "", constraints: "", acceptance: "",
    files: "[]", work_dir: "/tmp/work", executor: "opencode", session_id: "",
  } as any;
  const doc = renderTaskDoc(task, { sharedDir: shared });
  assert.match(doc, /## 汇报文件/);
  assert.match(doc, /shared\/task-7\.md/);
  assert.match(doc, /RB_SHARED_DIR/);
});
