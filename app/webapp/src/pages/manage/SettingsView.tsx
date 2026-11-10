import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { SchedulerSettings } from "../../lib/types.ts";
import { Button, Field, Input, StatusText } from "../../components/ui.tsx";

export function SettingsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [privateSec, setPrivateSec] = useState("");
  const [groupSec, setGroupSec] = useState("");
  const [taskSec, setTaskSec] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [saving, setSaving] = useState(false);

  const apply = useCallback((s: SchedulerSettings) => {
    setPrivateSec(String(Math.round(Number(s.privateWakeMs) / 1000)));
    setGroupSec(String(Math.round(Number(s.groupWakeMs) / 1000)));
    setTaskSec(String(Math.round(Number(s.taskWakeMs) / 1000)));
  }, []);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      apply(await request<SchedulerSettings>("/v1/scheduler"));
      setStatus({ text: "" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  const save = async () => {
    const fields: [keyof SchedulerSettings, string, string][] = [
      ["privateWakeMs", privateSec, "私聊唤醒间隔"],
      ["groupWakeMs", groupSec, "群聊唤醒间隔"],
      ["taskWakeMs", taskSec, "任务群唤醒间隔"],
    ];
    const body = {} as SchedulerSettings;
    for (const [key, raw, label] of fields) {
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        setStatus({ text: `${label}必须大于 0 秒`, error: true });
        return;
      }
      body[key] = Math.round(seconds * 1000);
    }
    setSaving(true);
    setStatus({ text: "保存中…" });
    try {
      apply(
        await request<SchedulerSettings>("/v1/scheduler", {
          method: "PUT",
          body,
        }),
      );
      setStatus({ text: "已保存并生效" });
    } catch (e) {
      setStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="my-3 grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
        <Field label="私聊唤醒间隔（秒）">
          <Input
            type="number"
            min={1}
            step={1}
            value={privateSec}
            onChange={(e) => setPrivateSec(e.target.value)}
          />
        </Field>
        <Field label="群聊唤醒间隔（秒）">
          <Input
            type="number"
            min={1}
            step={1}
            value={groupSec}
            onChange={(e) => setGroupSec(e.target.value)}
          />
        </Field>
        <Field label="任务群唤醒间隔（秒）">
          <Input
            type="number"
            min={1}
            step={1}
            value={taskSec}
            onChange={(e) => setTaskSec(e.target.value)}
          />
        </Field>
      </div>
      <div className="my-3">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
      <StatusText text={status.text} error={status.error} />
    </>
  );
}
