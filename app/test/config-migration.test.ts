import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, migrateLegacyKeys } from "../src/config.ts";

// 老配置段名 sandbox 改成了 exec。搬家做在「每一层原始 JSON」上，
// 因为默认配置里已经有 exec——等 deepMerge 完再看就分不清旧键是用户写的还是默认值。
test("config：旧键 sandbox 会被搬到 exec", () => {
  const raw: Record<string, unknown> = { sandbox: { shell: { mode: "host" } } };
  migrateLegacyKeys(raw, "test");
  assert.deepEqual(raw.exec, { shell: { mode: "host" } });
  assert.equal("sandbox" in raw, false);
});

test("config：两键并存时 exec 赢，sandbox 被丢掉", () => {
  const raw: Record<string, unknown> = {
    sandbox: { shell: { mode: "docker" } },
    exec: { shell: { mode: "host" } },
  };
  migrateLegacyKeys(raw, "test");
  assert.deepEqual(raw.exec, { shell: { mode: "host" } });
  assert.equal("sandbox" in raw, false);
});

test("config：没有旧键时什么都不做", () => {
  const raw: Record<string, unknown> = { exec: { shell: { mode: "host" } } };
  migrateLegacyKeys(raw, "test");
  assert.deepEqual(raw.exec, { shell: { mode: "host" } });
});

// 这条是真断言：旧配置文件里写 sandbox.shell.mode = "host"，
// loadConfig 之后必须是 exec.shell.mode === "host"。
// 如果搬家失效，这里会掉回默认 docker —— 那就等于她的 terminal 静默失去宿主机能力。
test("config：loadConfig 认旧配置文件里的 sandbox.shell.mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-cfg-"));
  const legacy = path.join(dir, "legacy.json");
  fs.writeFileSync(
    legacy,
    JSON.stringify({ sandbox: { shell: { mode: "host", enabled: true } } }),
    "utf8",
  );
  const prev = process.env.RABBIT_BOT_CONFIG;
  process.env.RABBIT_BOT_CONFIG = legacy;
  try {
    const cfg = loadConfig();
    assert.equal(cfg.exec.shell.mode, "host");
    assert.equal(cfg.exec.shell.enabled, true);
    assert.equal((cfg as unknown as Record<string, unknown>).sandbox, undefined);
  } finally {
    if (prev === undefined) delete process.env.RABBIT_BOT_CONFIG;
    else process.env.RABBIT_BOT_CONFIG = prev;
  }
});
