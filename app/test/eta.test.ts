import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/db.ts";
import { createTask, getTask } from "../src/core/tasks.ts";
import { parseEtaMs, formatEta } from "../src/core/eta.ts";

test("parseEtaMs：数字/纯数字按分钟，带单位按单位换算，空值 undefined，乱写 null", () => {
  assert.equal(parseEtaMs(30), 30 * 60_000);
  assert.equal(parseEtaMs("45"), 45 * 60_000);
  assert.equal(parseEtaMs("90s"), 90_000);
  assert.equal(parseEtaMs("30m"), 30 * 60_000);
  assert.equal(parseEtaMs("2h"), 2 * 3600_000);
  assert.equal(parseEtaMs("30分钟"), 30 * 60_000);
  assert.equal(parseEtaMs("1小时"), 3600_000);
  assert.equal(parseEtaMs(undefined), undefined);
  assert.equal(parseEtaMs(""), undefined);
  assert.equal(parseEtaMs("abc"), null);
  assert.equal(parseEtaMs(-5), 0, "负数按 0");
});

test("formatEta：人话", () => {
  assert.equal(formatEta(90_000), "2 分钟");
  assert.equal(formatEta(30 * 60_000), "30 分钟");
  assert.equal(formatEta(3600_000), "1 小时");
  assert.equal(formatEta(90 * 60_000), "1 小时 30 分钟");
});

test("createTask：eta_ms 落库，缺省 0", () => {
  const s = new Store(":memory:");
  const withEta = createTask(s, { userId: "u1", poolId: "p1", name: "#x", goal: "g", work_dir: "/tmp", eta_ms: 30 * 60_000 });
  assert.equal(getTask(s, withEta.id)?.eta_ms, 30 * 60_000);
  const noEta = createTask(s, { userId: "u1", poolId: "p1", name: "#y", goal: "g", work_dir: "/tmp" });
  assert.equal(getTask(s, noEta.id)?.eta_ms, 0);
  s.close();
});
