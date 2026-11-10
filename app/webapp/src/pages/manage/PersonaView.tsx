import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { RuntimeFile } from "../../lib/types.ts";
import { Button, Card, StatusText, Textarea } from "../../components/ui.tsx";

export function PersonaView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [persona, setPersona] = useState<RuntimeFile | null>(null);
  const [prompt, setPrompt] = useState<RuntimeFile | null>(null);
  const [personaText, setPersonaText] = useState("");
  const [promptText, setPromptText] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [saving, setSaving] = useState<"persona" | "prompt" | null>(null);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const [p, s] = await Promise.all([
        request<RuntimeFile>("/v1/persona"),
        request<RuntimeFile>("/v1/prompts/system"),
      ]);
      setPersona(p);
      setPrompt(s);
      setPersonaText(p.content ?? "");
      setPromptText(s.content ?? "");
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

  const savePersona = async () => {
    setSaving("persona");
    setStatus({ text: "保存中…" });
    try {
      const saved = await request<RuntimeFile>("/v1/persona", {
        method: "PUT",
        body: { content: personaText },
      });
      setPersona(saved);
      setStatus({ text: "人设已保存，下一轮换新会话生效。" });
    } catch (e) {
      setStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSaving(null);
    }
  };

  const savePrompt = async () => {
    setSaving("prompt");
    setStatus({ text: "保存中…" });
    try {
      const saved = await request<RuntimeFile>("/v1/prompts/system", {
        method: "PUT",
        body: { content: promptText },
      });
      setPrompt(saved);
      setStatus({ text: "系统提示词已保存，下一轮换新会话生效。" });
    } catch (e) {
      setStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <StatusText text={status.text} error={status.error} />
      <div className="mt-3 grid grid-cols-2 gap-4 max-[820px]:grid-cols-1">
        <Card className="flex min-w-0 flex-col gap-2">
          <div className="text-[13px] font-semibold">
            人设
            {persona && (
              <span className="mt-0.5 block text-[11px] font-normal break-all text-muted">
                {persona.source} · {persona.path}
              </span>
            )}
          </div>
          <Textarea
            className="min-h-[420px] font-mono text-[13px] leading-[1.55] max-[820px]:min-h-[300px]"
            spellCheck={false}
            rows={18}
            value={personaText}
            onChange={(e) => setPersonaText(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              disabled={saving !== null}
              onClick={() => void savePersona()}
            >
              保存人设
            </Button>
          </div>
        </Card>

        <Card className="flex min-w-0 flex-col gap-2">
          <div className="text-[13px] font-semibold">
            系统提示词
            {prompt && (
              <span className="mt-0.5 block text-[11px] font-normal break-all text-muted">
                {prompt.source} · {prompt.path}
              </span>
            )}
          </div>
          <Textarea
            className="min-h-[420px] font-mono text-[13px] leading-[1.55] max-[820px]:min-h-[300px]"
            spellCheck={false}
            rows={18}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              disabled={saving !== null}
              onClick={() => void savePrompt()}
            >
              保存系统提示词
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}
