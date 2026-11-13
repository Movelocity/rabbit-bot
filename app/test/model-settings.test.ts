import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { effectiveModelSettings, loadModelSettings, saveModelSettings } from "../src/ops/model-settings.ts";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rabbit-bot-model-settings-"));
  const cfg = loadConfig({
    runtimeDir: dir,
    llm: {
      provider: "deepseek",
      model: "deepseek-flash",
      models: [
        { provider: "deepseek", model: "deepseek-flash", label: "默认" },
        { provider: "openrouter", model: "gemini-4-argon", label: "备用" },
      ],
    },
  });
  return { dir, cfg, cleanup() { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("没有运行时文件时用配置里的默认模型和备用清单", () => {
  const x = fixture();
  try {
    const s = loadModelSettings(x.cfg);
    assert.equal(s.provider, "deepseek");
    assert.equal(s.model, "deepseek-flash");
    assert.deepEqual(s.choices.map((c) => `${c.provider}/${c.model}`), [
      "deepseek/deepseek-flash",
      "openrouter/gemini-4-argon",
    ]);
  } finally { x.cleanup(); }
});

test("保存后重启能读回当前模型，切换目标自动补进清单", () => {
  const x = fixture();
  try {
    const saved = saveModelSettings(x.cfg, {
      provider: "openrouter",
      model: "gemini-4-argon",
      choices: [{ provider: "deepseek", model: "deepseek-flash" }],
    });
    assert.equal(saved.provider, "openrouter");
    assert.equal(saved.model, "gemini-4-argon");
    assert.ok(saved.choices.some((c) => c.provider === "openrouter" && c.model === "gemini-4-argon"));

    const restarted = loadConfig({ runtimeDir: x.dir, llm: { provider: "deepseek", model: "deepseek-flash" } });
    const loaded = loadModelSettings(restarted);
    assert.equal(restarted.llm.provider, "openrouter");
    assert.equal(restarted.llm.model, "gemini-4-argon");
    assert.deepEqual(loaded.choices.map((c) => `${c.provider}/${c.model}`), [
      "openrouter/gemini-4-argon",
      "deepseek/deepseek-flash",
    ]);
  } finally { x.cleanup(); }
});

test("清单去重、过滤坏条目，并保证当前模型在列表里", () => {
  const x = fixture();
  try {
    const s = saveModelSettings(x.cfg, {
      choices: [
        { provider: "deepseek", model: "deepseek-flash" },
        { provider: "deepseek", model: "deepseek-flash" },
        { provider: "", model: "bad" },
        { provider: "openrouter", model: "  gemini-4-argon  ", label: " 备用 " },
      ],
    });
    assert.deepEqual(s.choices.map((c) => `${c.provider}/${c.model}`), [
      "deepseek/deepseek-flash",
      "openrouter/gemini-4-argon",
    ]);
    assert.equal(s.choices[1].label, "备用");
    assert.equal(effectiveModelSettings(x.cfg).model, "deepseek-flash");
  } finally { x.cleanup(); }
});
