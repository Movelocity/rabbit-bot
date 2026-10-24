import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { acquireLock, releaseLock, readLock, stillHolder, procStartTime, processAlive } from "../src/core/lockfile.ts";

function tmpLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poolchat-lock-"));
  return path.join(dir, "run", "main.pid");
}

/** 起一个真实的 node 子进程当「另一个 poolchat」，故意用跟本体不同的命令行。 */
function fakeProc(): Promise<{ pid: number; boot: string; kill: () => void }> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  return new Promise((resolve) => {
    child.on("spawn", () => {
      // 等 ps 能查到启动时间
      const tick = setInterval(() => {
        const boot = procStartTime(child.pid!);
        if (boot) {
          clearInterval(tick);
          resolve({ pid: child.pid!, boot, kill: () => child.kill("SIGKILL") });
        }
      }, 20);
    });
  });
}

test("空目录：拿到锁，文件里是自己的 pid 和启动时间", () => {
  const f = tmpLock();
  const r = acquireLock(f);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.tookOver, false);
  const lock = readLock(f);
  assert.equal(lock?.pid, process.pid);
  assert.ok(lock?.boot, "应该记下自己的启动时间");
  releaseLock(f);
  assert.equal(readLock(f), null);
});

test("同进程重入：认得自己，不自杀", () => {
  const f = tmpLock();
  assert.equal(acquireLock(f).ok, true);
  const again = acquireLock(f);
  assert.equal(again.ok, true);
  assert.equal(again.ok && again.samePidReentry, true);
  releaseLock(f);
});

test("持有者是活着的真进程（命令行完全不像 poolchat 也认得出来）：让路", async () => {
  const f = tmpLock();
  const fake = await fakeProc();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: fake.pid, boot: fake.boot, startedAt: Date.now(), cmd: "node -e ..." }));
    assert.equal(stillHolder({ pid: fake.pid, boot: fake.boot, startedAt: 0, cmd: "" }), true);
    const r = acquireLock(f);
    assert.equal(r.ok, false, "不该抢活进程的锁");
    assert.equal(r.ok === false && r.holder.pid, fake.pid);
    assert.equal(readLock(f)?.pid, fake.pid, "别人的锁不该被改写");
  } finally {
    fake.kill();
  }
});

test("pid 被复用（同一个 pid，启动时间对不上）：接管", async () => {
  const f = tmpLock();
  const fake = await fakeProc();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: fake.pid, boot: "Thu Jan  1 00:00:00 1970", startedAt: 0, cmd: "" }));
    assert.equal(stillHolder({ pid: fake.pid, boot: "Thu Jan  1 00:00:00 1970", startedAt: 0, cmd: "" }), false);
    const r = acquireLock(f);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.tookOver, true);
    releaseLock(f);
  } finally {
    fake.kill();
  }
});

test("锁里没有启动时间（旧格式/刚 spawn）：pid 活着就保守让路", async () => {
  const f = tmpLock();
  const fake = await fakeProc();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pid: fake.pid, boot: "", startedAt: 0, cmd: "" }));
    assert.equal(stillHolder({ pid: fake.pid, boot: "", startedAt: 0, cmd: "" }), true, "拿不准的时候当它活着");
    const r = acquireLock(f);
    assert.equal(r.ok, false, "不该抢一个还活着的进程的锁");
  } finally {
    fake.kill();
  }
});

test("stale 锁（进程早没了）：接管", () => {
  const f = tmpLock();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, boot: "whatever", startedAt: 0, cmd: "" }));
  const r = acquireLock(f);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.tookOver, true);
  releaseLock(f);
});

test("空文件 / 纯 pid 旧格式：都能处理", () => {
  const f1 = tmpLock();
  fs.mkdirSync(path.dirname(f1), { recursive: true });
  fs.writeFileSync(f1, "");
  assert.equal(acquireLock(f1).ok, true);
  releaseLock(f1);

  const f2 = tmpLock();
  fs.mkdirSync(path.dirname(f2), { recursive: true });
  fs.writeFileSync(f2, "999998"); // 旧格式，进程不存在
  const r = acquireLock(f2);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.tookOver, true);
  releaseLock(f2);
});

test("releaseLock 不删别人的锁", () => {
  const f = tmpLock();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ pid: 1, boot: "", startedAt: 0, cmd: "" }));
  releaseLock(f);
  assert.equal(readLock(f)?.pid, 1);
  fs.rmSync(path.dirname(path.dirname(f)), { recursive: true, force: true });
});

test("并发抢同一把锁：只有一个能拿到", async () => {
  const f = tmpLock();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const mod = new URL("../src/core/lockfile.ts", import.meta.url).href;
  const script = `
    import { acquireLock } from ${JSON.stringify(mod)};
    const r = acquireLock(${JSON.stringify(f)});
    process.stdout.write(r.ok ? "ok" : "busy");
    // 赢家必须多活一会儿：真实场景里拿到锁的进程一直活着。如果拿完就退出，
    // 锁自然释放、后面的人合法接管，那出现多个 ok 是对的——测的就不是单例了。
    if (r.ok) setTimeout(() => {}, 1200);
  `;
  const run = () =>
    new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ["--experimental-strip-types", "-e", script], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => (out += String(d)));
      c.on("close", () => resolve(out.trim()));
    });
  const results = await Promise.all(Array.from({ length: 10 }, run));
  const wins = results.filter((x) => x === "ok").length;
  assert.equal(wins, 1, `10 个并发只该有 1 个成功的，实际 ${JSON.stringify(results)}`);
  fs.rmSync(path.dirname(path.dirname(f)), { recursive: true, force: true });
});

test("pid 存活判断", () => {
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(999999), false);
  assert.equal(processAlive(0), false);
});
