import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  envFile, expandHome, hostModeSupported, isInside, isInsideWith, killPlan, procStartTimeCommand, resolveExecutable, spawnPlan,
} from "../src/core/platform.ts";
import { mountFingerprint, sandboxMountArgs, sandboxUserArgs } from "../src/core/shell-runner.ts";

test("expandHome：~ 和 ~/ 展开到给定家目录，其他原样", () => {
  assert.equal(expandHome("", "/home/u"), "");
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("~/runtime", "/home/u"), path.join("/home/u", "runtime"));
  assert.equal(expandHome("/abs/path", "/home/u"), "/abs/path");
  assert.equal(expandHome("relative/path", "/home/u"), "relative/path");
});

test("envFile：RABBIT_BOT_ENV_FILE 优先，否则 ~/.config/rabbit-bot/env", () => {
  assert.equal(envFile({}, "/home/u"), path.join("/home/u", ".config", "rabbit-bot", "env"));
  assert.equal(envFile({ RABBIT_BOT_ENV_FILE: "/run/rb.env" }, "/home/u"), path.resolve("/run/rb.env"));
  assert.equal(envFile({ RABBIT_BOT_ENV_FILE: "~/rb.env" }, "/home/u"), path.resolve("/home/u/rb.env"));
});

test("isInside：POSIX 大小写敏感，前缀目录不算包含", () => {
  assert.equal(isInsideWith("/work", "/work", path.posix), true);
  assert.equal(isInsideWith("/work", "/work/a/b", path.posix), true);
  assert.equal(isInsideWith("/work", "/work2/a", path.posix), false);
  assert.equal(isInsideWith("/work", "/work/../escape", path.posix), false);
  assert.equal(isInside("/work", "/work/a"), true);
});

test("isInsideWith：win32 盘符与大小写不敏感", () => {
  assert.equal(isInsideWith("C:\\work", "c:\\WORK\\a", path.win32, true), true);
  assert.equal(isInsideWith("C:\\work", "C:\\work2\\a", path.win32, true), false);
  assert.equal(isInsideWith("C:\\work", "D:\\work\\a", path.win32, true), false);
  assert.equal(isInsideWith("C:\\work", "C:\\work\\..\\escape", path.win32, true), false);
});

test("resolveExecutable：绝对路径存在时原样返回", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-platform-"));
  const file = path.join(dir, "tool");
  fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(resolveExecutable(file), file);
});

test("spawnPlan：Windows .cmd/.bat 走 shell，其余直接 spawn", () => {
  assert.deepEqual(spawnPlan("C:\\tools\\opencode.cmd", ["run", "x"], "win32"), {
    file: "C:\\tools\\opencode.cmd", args: ["run", "x"], shell: true,
  });
  assert.deepEqual(spawnPlan("/usr/local/bin/opencode", ["run", "x"], "darwin"), {
    file: "/usr/local/bin/opencode", args: ["run", "x"], shell: false,
  });
});

test("killPlan：POSIX 交回 process.kill，Windows 用 taskkill /T /F", () => {
  assert.equal(killPlan(42, "SIGTERM", "darwin"), null);
  assert.deepEqual(killPlan(42, "SIGTERM", "win32"), { bin: "taskkill", args: ["/PID", "42", "/T"] });
  assert.deepEqual(killPlan(42, "SIGKILL", "win32"), { bin: "taskkill", args: ["/PID", "42", "/T", "/F"] });
});

test("procStartTimeCommand：按平台选择 ps / PowerShell", () => {
  assert.deepEqual(procStartTimeCommand(7, "darwin"), { bin: "/bin/ps", args: ["-p", "7", "-o", "lstart="] });
  const win = procStartTimeCommand(7, "win32");
  assert.equal(win.bin, "powershell.exe");
  assert.match(win.args.join(" "), /Get-Process -Id 7/);
});

test("hostModeSupported：原生 Windows 不支持 host 模式", () => {
  assert.equal(hostModeSupported("darwin"), true);
  assert.equal(hostModeSupported("linux"), true);
  assert.equal(hostModeSupported("win32"), false);
});

test("Docker 挂载：--mount 参数与指纹不依赖顺序和 Source 原始形式", () => {
  const a = { host: "C:\\Users\\me\\runtime", container: "/work", mode: "rw" as const };
  const b = { host: "C:\\Users\\me\\shared-skills", container: "/work/shared-skills", mode: "ro" as const };
  assert.equal(mountFingerprint([a, b], "win32"), mountFingerprint([b, a], "win32"));
  assert.notEqual(mountFingerprint([a, b], "win32"), mountFingerprint([a], "win32"));
  assert.deepEqual(sandboxMountArgs(a, "win32"), [
    "--mount", "type=bind,source=C:/Users/me/runtime,target=/work",
  ]);
  assert.deepEqual(sandboxMountArgs(b, "win32"), [
    "--mount", "type=bind,source=C:/Users/me/shared-skills,target=/work/shared-skills,readonly",
  ]);
});

test("sandboxUserArgs：POSIX 传真实 uid/gid，Windows 不传 --user", () => {
  assert.deepEqual(sandboxUserArgs("darwin", 501, 20), ["--user", "501:20"]);
  assert.deepEqual(sandboxUserArgs("linux", 1000, 1000), ["--user", "1000:1000"]);
  assert.deepEqual(sandboxUserArgs("win32", undefined, undefined), []);
});
