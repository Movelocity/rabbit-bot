import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInSandbox, type SandboxShellOptions } from "../src/core/sandbox-shell.ts";

const hasDocker = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
})();

const skip = hasDocker ? false : "没有可用的 docker，跳过容器沙盒测试";

// 有自建镜像就用它（带 python/git/curl/bash/jq/rg），没有就退回基础镜像
const image = (() => {
  try {
    execFileSync("docker", ["image", "inspect", "rabbit-bot-sandbox:latest"], { stdio: "ignore", timeout: 8000 });
    return "rabbit-bot-sandbox:latest";
  } catch {
    return "node:22-alpine";
  }
})();
const container = "rabbit-bot-sbx-test";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-sbxsh-"));
const opts: SandboxShellOptions = {
  container,
  image,
  volumes: [{ host: workspace, container: "/work", mode: "rw" }],
  network: "bridge",
  timeoutMs: 15000,
  maxOutputChars: 4000,
};

test.after(() => {
  try {
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 20000 });
  } catch {
    /* 没建起来就没什么可删 */
  }
});

test("容器里能跑命令，写 /work 会落到宿主沙盒目录", { skip }, async () => {
  const r = await runInSandbox("echo hello && node -v", opts);
  assert.equal(r.ok, true);
  assert.match(r.output, /hello/);
  assert.match(r.output, /v22/);

  const w = await runInSandbox("echo from-sbx > /work/out.txt && echo done", opts);
  assert.equal(w.ok, true);
  assert.equal(fs.readFileSync(path.join(workspace, "out.txt"), "utf8").trim(), "from-sbx");
});

test("宿主机的路径在容器里不存在", { skip }, async () => {
  const r = await runInSandbox("ls /Users 2>&1 | head -1", opts);
  assert.match(r.output, /No such file or directory/);
});

test("网络按 network 模式走：none 断网，bridge 通", { skip }, async () => {
  const probe = 'node -e "fetch(\'https://api.deepseek.com\').then(()=>console.log(\'NET-OK\')).catch(()=>console.log(\'NET-FAIL\'))"';
  // 同一个容器改了 network 要重建，所以两种模式各用一个容器名
  const offline = await runInSandbox(probe, { ...opts, container: `${container}-none`, network: "none" });
  assert.match(offline.output, /NET-FAIL/);
  try {
    execFileSync("docker", ["rm", "-f", `${container}-none`], { stdio: "ignore", timeout: 20000 });
  } catch {
    /* ignore */
  }
  const online = await runInSandbox(probe, { ...opts, container: `${container}-bridge`, network: "bridge" });
  assert.match(online.output, /NET-OK/);
  try {
    execFileSync("docker", ["rm", "-f", `${container}-bridge`], { stdio: "ignore", timeout: 20000 });
  } catch {
    /* ignore */
  }
});

test("根目录只读，只有 /work 和 /tmp 可写", { skip }, async () => {
  const r = await runInSandbox("echo x > /nope.txt 2>&1; echo y > /tmp/ok.txt && echo tmp-ok", opts);
  assert.match(r.output, /Read-only file system/);
  assert.match(r.output, /tmp-ok/);
});

test("命令超时会被杀掉", { skip }, async () => {
  const r = await runInSandbox("sleep 30", { ...opts, timeoutMs: 1500 });
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 0);
});
