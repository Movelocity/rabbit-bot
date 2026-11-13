/** 执行器探测：能识别 PATH / MIMO_BIN 里的 CLI，并且不会因为缺失就抛错。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listExecutors } from "../src/ops/executors.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-executors-"));

function fake(name: string, version: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return file;
}

test("探测本机 opencode / mimo 的可用性和版本", () => {
  const opencode = fake("opencode", "9.9.9-opencode");
  const mimo = fake("mimo", "9.9.9-mimo");
  const oldPath = process.env.PATH;
  const oldMimo = process.env.MIMO_BIN;
  process.env.PATH = `${dir}:${oldPath ?? "/usr/bin:/bin"}`;
  process.env.MIMO_BIN = mimo;
  try {
    const list = listExecutors(Date.now() + 3600_000);
    assert.deepEqual(list.map((e) => e.name), ["opencode", "mimo"]);
    for (const e of list) {
      assert.equal(e.available, true, `${e.name} 应可用`);
      assert.equal(e.version, `9.9.9-${e.name}`);
      assert.equal(e.error, "");
    }
    assert.equal(list[0].bin, opencode);
    assert.equal(list[1].bin, mimo);
  } finally {
    process.env.PATH = oldPath;
    process.env.MIMO_BIN = oldMimo;
  }
});

test("没装的 CLI 返回 available=false，不抛异常", () => {
  const missing = path.join(dir, "nope-mimo");
  const oldPath = process.env.PATH;
  const oldMimo = process.env.MIMO_BIN;
  process.env.PATH = "/usr/bin:/bin";
  process.env.MIMO_BIN = missing;
  try {
    const list = listExecutors(Date.now() + 7200_000);
    const mimo = list.find((e) => e.name === "mimo")!;
    assert.equal(mimo.available, false);
    assert.equal(mimo.bin, missing);
    assert.ok(mimo.error);
  } finally {
    process.env.PATH = oldPath;
    process.env.MIMO_BIN = oldMimo;
  }
});
