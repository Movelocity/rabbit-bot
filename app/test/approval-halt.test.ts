/** 审批被拒 = 强制收手：引擎在本轮 tool_execution_end 后立即 abort，不允许换命令重试。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../src/env-defaults.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/core/db.ts";
import { Logger } from "../src/core/logger.ts";
import { createTools } from "../src/agent/tools.ts";
import { PiEngine } from "../src/agent/engine.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

test("审批被拒后引擎中止本轮，不再执行后续终端调用", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-approval-halt-"));
  const cfg = loadConfig({
    dataDir, logDir: path.join(dataDir, "logs"), runtimeDir: path.join(dataDir, "runtime"),
    exec: { dir: path.join(dataDir, "sandbox") },
    llm: { provider: "faux-halt", model: "faux-brain" },
  });
  cfg.exec.shell.mode = "host";
  cfg.exec.shell.host = { cwd: cfg.exec.dir, inheritEnv: false };

  const asked: string[] = [];
  const gate = {
    enabled: true,
    request: async (req: { cmd: string }) => {
      asked.push(req.cmd);
      return { id: 1, decision: "rejected" as const, latencyMs: 1 };
    },
    reportDone: () => undefined,
  };
  const store = new Store(":memory:");
  const tools = createTools({
    store, hub: {} as any, cfg, now: () => Date.now(), profile: "ufa",
    approval: gate as any,
  }) as any[];

  const piDir = path.join(dataDir, "pi-agent");
  fs.mkdirSync(piDir, { recursive: true });
  const faux = fauxProvider({
    provider: "faux-halt",
    models: [{ id: "faux-brain", contextWindow: 200_000, maxTokens: 4096 }],
    tokensPerSecond: 100_000,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(piDir, "auth.json"), modelsPath: path.join(piDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  // 模型「倔」：第一次被拒后还想换一条命令继续；引擎若没打断，就会问第二次审批。
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("terminal", { cmd: "rm -rf build" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("terminal", { cmd: "rm -rf build" }), { stopReason: "toolUse" }),
  ]);

  const engine = new PiEngine({
    cfg, store, log: new Logger(null, true), tools, systemPrompt: () => "测试用系统提示词。",
    model: faux.getModel(), modelRuntime, inMemorySessions: true,
  });
  try {
    const res = await engine.run("跑一下", { tokensLeft: 100_000, callsLeft: 100 });
    assert.equal(asked.length, 1, "被拒后不该再发起第二次审批");
    assert.equal(res.aborted, true, "审批被拒必须打断本轮");
    assert.equal(res.abortReason, "approval-rejected");
  } finally {
    await engine.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
