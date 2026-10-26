import { test } from "node:test";
import assert from "node:assert/strict";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";

// codemode 沙箱的隔离边界：脚本里除了 tools.*，什么都拿不到。
// 这条测试是给 rabbit-bot 开 codemode 的安全前提，改动沙箱配置时先看它。

function out(result: { output?: Array<{ text?: string }> }): string {
  return (result.output ?? []).map((o) => o.text ?? "").join("");
}

test("沙盒里没有 require / fetch / process / 定时器 / WebAssembly", async () => {
  const sandbox = new CodemodeSandbox({ timeoutMs: 5000 });
  try {
    const r = await sandbox.execute(
      "text(JSON.stringify({require: typeof require, fetch: typeof fetch, process: typeof process, " +
        "WebAssembly: typeof WebAssembly, setTimeout: typeof setTimeout, keys: Object.keys(globalThis).sort().join(',')}))",
    );
    assert.equal(r.ok, true);
    const probe = JSON.parse(out(r));
    assert.equal(probe.require, "undefined");
    assert.equal(probe.fetch, "undefined");
    assert.equal(probe.process, "undefined");
    assert.equal(probe.WebAssembly, "undefined");
    assert.equal(probe.setTimeout, "undefined");
    // 全局对象只有沙箱自己给的那几个
    assert.deepEqual(probe.keys.split(","), ["ALL_TOOLS", "console", "exit", "image", "load", "performance", "store", "text", "tools"]);
  } finally {
    await sandbox.close();
  }
});

test("死循环会被超时掐掉，不会拖住进程", async () => {
  const sandbox = new CodemodeSandbox({ timeoutMs: 1200 });
  try {
    const started = Date.now();
    const r = await sandbox.execute("while (true) {}");
    const cost = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.error?.kind, "timeout");
    assert.ok(cost < 8000, `超时没生效，耗时 ${cost}ms`);
  } finally {
    await sandbox.close();
  }
});

test("脚本能调到注入的工具，返回值是 JSON round trip 之后的", async () => {
  const sandbox = new CodemodeSandbox({
    timeoutMs: 5000,
    tools: [
      {
        name: "read_pool",
        description: "读池",
        execute: (args: unknown) => `pool=${JSON.stringify(args)}`,
      },
    ],
  });
  try {
    const r = await sandbox.execute(
      "const a = await tools.read_pool({pool: 'p1', limit: 2}); text('got:' + a)",
    );
    assert.equal(r.ok, true);
    assert.equal(out(r), 'got:pool={"pool":"p1","limit":2}');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, "read_pool");
  } finally {
    await sandbox.close();
  }
});
