import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { ModelChoice, ModelSettings, ModelSettingsResponse } from "../../lib/types.ts";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHead,
  CardMeta,
  CardTitle,
  Empty,
  Field,
  Input,
  Select,
  StatusText,
} from "../../components/ui.tsx";

const keyOf = (choice: Pick<ModelChoice, "provider" | "model">) =>
  JSON.stringify([choice.provider, choice.model]);

export function ModelsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [data, setData] = useState<ModelSettingsResponse | null>(null);
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [pick, setPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const next = await request<ModelSettingsResponse>("/v1/llm/models");
      setData(next);
      setChoices(next.choices);
      setStatus({ text: "" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  const merged = (saved: ModelSettings, previous: ModelSettingsResponse): ModelSettingsResponse => ({
    ...previous,
    provider: saved.provider,
    model: saved.model,
    choices: saved.choices,
  });

  const persistChoices = async (next: ModelChoice[]) => {
    if (!data) return;
    setSaving(true);
    try {
      const saved = await request<ModelSettings>("/v1/llm/models", {
        method: "PUT",
        body: { choices: next },
      });
      setData(merged(saved, data));
      setChoices(saved.choices);
      setStatus({ text: "模型列表已保存" });
    } catch (e) {
      setStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSaving(false);
    }
  };

  const addCustom = async () => {
    const p = provider.trim();
    const m = model.trim();
    if (!p || !m) {
      setStatus({ text: "provider 和 model 都要填", error: true });
      return;
    }
    if (choices.some((c) => c.provider === p && c.model === m)) {
      setStatus({ text: "这个模型已经在列表里了", error: true });
      return;
    }
    const choice: ModelChoice = { provider: p, model: m, ...(label.trim() ? { label: label.trim() } : {}) };
    await persistChoices([...choices, choice]);
    setProvider("");
    setModel("");
    setLabel("");
  };

  const addAvailable = async () => {
    if (!pick || !data) return;
    const found = data.available.find((x) => keyOf(x) === pick);
    if (!found) return;
    if (choices.some((c) => c.provider === found.provider && c.model === found.model)) {
      setStatus({ text: "这个模型已经在列表里了", error: true });
      return;
    }
    await persistChoices([
      ...choices,
      { provider: found.provider, model: found.model, label: found.name },
    ]);
    setPick("");
  };

  const remove = async (choice: ModelChoice) => {
    if (!data) return;
    if (choice.provider === data.provider && choice.model === data.model) {
      setStatus({ text: "当前正在用的模型不能删，先切到别的模型", error: true });
      return;
    }
    await persistChoices(choices.filter((c) => keyOf(c) !== keyOf(choice)));
  };

  const switchTo = async (choice: ModelChoice) => {
    const key = keyOf(choice);
    setSwitching(key);
    setStatus({ text: `正在切换到 ${choice.provider}/${choice.model}…` });
    try {
      const saved = await request<ModelSettings>("/v1/llm/switch", {
        method: "POST",
        body: { provider: choice.provider, model: choice.model },
      });
      setData((prev) => (prev ? merged(saved, prev) : prev));
      setChoices(saved.choices);
      setStatus({ text: `已切换到 ${saved.provider}/${saved.model}；下一轮唤醒会用新模型重建会话。` });
    } catch (e) {
      setStatus({ text: `切换失败：${friendlyError(e)}`, error: true });
    } finally {
      setSwitching("");
    }
  };

  const availableOptions = useMemo(() => {
    if (!data) return [];
    const existing = new Set(choices.map(keyOf));
    return data.available
      .filter((x) => !existing.has(keyOf(x)))
      .map((x) => ({
        value: keyOf(x),
        label: `${x.provider} / ${x.model}${x.name && x.name !== x.model ? ` · ${x.name}` : ""}`,
      }));
  }, [choices, data]);

  return (
    <>
      <StatusText text={status.text} error={status.error} />

      <Card>
        <CardHead>
          <CardTitle>当前模型</CardTitle>
          <Badge variant="info">{data ? `${data.provider} / ${data.model}` : "—"}</Badge>
        </CardHead>
        <CardBody>
          <p className="m-0 text-[12.5px] leading-relaxed text-muted">
            切换会立即生效：当前 pi 会话会被丢掉，下一轮唤醒用新模型重建。
          </p>
          {data?.available_error ? (
            <p className="mt-2 text-xs text-amber">
              可用模型探测失败：{data.available_error}
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card className="mt-2.5">
        <CardHead>
          <CardTitle>备用模型</CardTitle>
          <Badge>{choices.length} 个</Badge>
        </CardHead>
        <CardBody>
          {!choices.length ? (
            <Empty>还没有配置模型。</Empty>
          ) : (
            <div className="grid gap-1.5">
              {choices.map((choice) => {
                const active = data?.provider === choice.provider && data?.model === choice.model;
                const key = keyOf(choice);
                return (
                  <div
                    key={key}
                    className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface2 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[12px]">
                          {choice.provider} / {choice.model}
                        </span>
                        {active ? <Badge variant="done">使用中</Badge> : null}
                      </div>
                      {choice.label ? (
                        <div className="mt-0.5 text-[11px] text-muted">{choice.label}</div>
                      ) : null}
                    </div>
                    <Button
                      variant={active ? "ghost" : "primary"}
                      size="sm"
                      disabled={active || saving || !!switching}
                      onClick={() => void switchTo(choice)}
                    >
                      {active ? "当前" : switching === key ? "切换中…" : "切换"}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={active || saving || !!switching}
                      onClick={() => void remove(choice)}
                    >
                      删除
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
        <CardMeta className="px-4 pb-4">
          <span>删除不影响当前会话里的上下文，只改可选列表。</span>
        </CardMeta>
      </Card>

      <Card className="mt-2.5">
        <CardHead>
          <CardTitle>添加模型</CardTitle>
        </CardHead>
        <CardBody>
          {availableOptions.length ? (
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <Field label="从有凭据的模型里选" grow>
                <Select
                  value={pick}
                  onValueChange={setPick}
                  options={[{ value: "", label: "选择模型…" }, ...availableOptions]}
                  ariaLabel="可用模型"
                />
              </Field>
              <Button variant="primary" size="sm" disabled={!pick || saving} onClick={() => void addAvailable()}>
                添加
              </Button>
            </div>
          ) : null}

          <div className="grid grid-cols-[minmax(120px,1fr)_minmax(160px,1.4fr)_minmax(120px,1fr)] items-end gap-2 max-[820px]:grid-cols-1">
            <Field label="provider">
              <Input
                value={provider}
                placeholder="deepseek / openrouter…"
                onChange={(e) => setProvider(e.target.value)}
              />
            </Field>
            <Field label="model">
              <Input
                value={model}
                placeholder="deepseek-flash / gemini-4-argon…"
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>
            <Field label="备注（可选）">
              <Input value={label} placeholder="主用 / 便宜 / 备用" onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => void addCustom()}>
              {saving ? "保存中…" : "添加到列表"}
            </Button>
          </div>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted">
            也可以直接在 config/local.json 的 <code className="font-mono">llm.models</code> 里预置多个
            provider / model；管理台保存后会以运行时列表为准。
          </p>
        </CardBody>
      </Card>
    </>
  );
}
