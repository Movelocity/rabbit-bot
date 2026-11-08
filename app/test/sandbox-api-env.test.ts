/** 沙盒 shell 自动带 API 地址/token；host 和 docker 的地址不同。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { shellRunnerOptions } from "../src/ops/exec.ts";
import { resolveApiToken } from "../src/api-token.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-api-env-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const mk = (mode: "docker" | "host", port = 3738) => loadConfig({
  dataDir: dir,
  api: { enabled: true, port, host: "0.0.0.0" },
  exec: { shell: { mode } },
});

test("docker 模式注入 host.docker.internal，token 落盘 0600", () => {
  delete process.env.RABBIT_BOT_API_TOKEN;
  const cfg = mk("docker");
  const opts = shellRunnerOptions(cfg);
  assert.equal(opts.env?.RB_API_URL, "http://host.docker.internal:3738");
  const token = opts.env?.RB_API_TOKEN ?? "";
  assert.equal(token.length, 64);

  const file = path.join(dir, "run", "api.token");
  assert.equal(fs.readFileSync(file, "utf8").trim(), token);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(resolveApiToken(cfg), token);
});

test("host 模式注入 127.0.0.1", () => {
  const opts = shellRunnerOptions(mk("host", 4567));
  assert.equal(opts.env?.RB_API_URL, "http://127.0.0.1:4567");
});

test("RABBIT_BOT_API_TOKEN 优先于文件", () => {
  process.env.RABBIT_BOT_API_TOKEN = "env-token-env-token";
  try {
    assert.equal(shellRunnerOptions(mk("docker")).env?.RB_API_TOKEN, "env-token-env-token");
  } finally {
    delete process.env.RABBIT_BOT_API_TOKEN;
  }
});

test("api.port 越界在加载时就拒绝", () => {
  assert.throws(() => mk("docker", 70000), /api\.port/);
});
