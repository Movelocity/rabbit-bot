/**
 * 管理台可切换的模型清单与当前选择。
 *
 * 配置里的 llm.provider/model 是默认值；管理台改过之后落到运行时目录，
 * 重启仍然生效。清单同样存运行时，避免为了加一个备用模型去改仓库配置。
 */
import fs from "node:fs";
import path from "node:path";
import type { Config, ModelChoice } from "../config.ts";
import { runtimePath } from "../core/runtime.ts";

const FILE = "model-settings.json";
export const MAX_MODEL_CHOICES = 50;

export interface ModelSettings {
  provider: string;
  model: string;
  choices: ModelChoice[];
}

function normText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function normalizeChoice(raw: unknown): ModelChoice | null {
  if (!raw || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  const provider = normText(x.provider);
  const model = normText(x.model);
  if (!provider || !model) return null;
  const label = normText(x.label);
  return { provider, model, ...(label ? { label } : {}) };
}

function dedupe(list: ModelChoice[]): ModelChoice[] {
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const choice of list) {
    const key = `${choice.provider}\u0000${choice.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(choice);
  }
  return out;
}

function ensureActive(choices: ModelChoice[], provider: string, model: string): ModelChoice[] {
  const list = dedupe(choices);
  if (!list.some((c) => c.provider === provider && c.model === model)) {
    list.unshift({ provider, model });
  }
  return list.slice(0, MAX_MODEL_CHOICES);
}

function readFile(cfg: Config): Partial<ModelSettings> {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimePath(cfg, FILE), "utf8")) as Record<string, unknown>;
    return {
      provider: normText(raw.provider),
      model: normText(raw.model),
      choices: Array.isArray(raw.choices)
        ? raw.choices.map(normalizeChoice).filter((x): x is ModelChoice => !!x)
        : undefined,
    };
  } catch {
    return {};
  }
}

function apply(cfg: Config, settings: ModelSettings): ModelSettings {
  const choices = ensureActive(settings.choices, settings.provider, settings.model);
  const next = { provider: settings.provider, model: settings.model, choices };
  cfg.llm.provider = next.provider;
  cfg.llm.model = next.model;
  cfg.llm.models = next.choices;
  return next;
}

/** 当前生效的模型与清单（不读写磁盘）。 */
export function effectiveModelSettings(cfg: Config): ModelSettings {
  const provider = normText(cfg.llm.provider);
  const model = normText(cfg.llm.model);
  const choices = (cfg.llm.models ?? []).map(normalizeChoice).filter((x): x is ModelChoice => !!x);
  return apply(cfg, { provider, model, choices });
}

/** 启动时把运行时选择合并进 cfg；文件不存在就沿用配置里的默认值。 */
export function loadModelSettings(cfg: Config): ModelSettings {
  const saved = readFile(cfg);
  const provider = saved.provider || normText(cfg.llm.provider);
  const model = saved.model || normText(cfg.llm.model);
  const choices = saved.choices
    ?? (cfg.llm.models ?? []).map(normalizeChoice).filter((x): x is ModelChoice => !!x);
  return apply(cfg, { provider, model, choices });
}

/** 保存当前模型与清单；同时更新 cfg，后续 API 读取立即生效。 */
export function saveModelSettings(cfg: Config, input: {
  provider?: string;
  model?: string;
  choices?: ModelChoice[];
}): ModelSettings {
  const current = effectiveModelSettings(cfg);
  const provider = normText(input.provider) || current.provider;
  const model = normText(input.model) || current.model;
  if (!provider || !model) throw new Error("缺少 provider / model");
  const rawChoices = input.choices ?? current.choices;
  const choices = rawChoices.map(normalizeChoice).filter((x): x is ModelChoice => !!x);
  const next = apply(cfg, { provider, model, choices });
  const file = runtimePath(cfg, FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}
