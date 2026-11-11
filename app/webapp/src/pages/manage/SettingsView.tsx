import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import type { MemoryReviewSettings, SchedulerSettings } from "../../lib/types.ts";
import { Button, Card, CardBody, CardHead, CardTitle, Field, Input, Select, StatusText } from "../../components/ui.tsx";

const DEFAULT_MEMORY_REVIEW: MemoryReviewSettings = {
  enabled: false,
  everyTurns: 10,
  minIntervalSec: 300,
};

export function SettingsView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [privateSec, setPrivateSec] = useState("");
  const [groupSec, setGroupSec] = useState("");
  const [taskSec, setTaskSec] = useState("");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [saving, setSaving] = useState(false);

  const [memoryReview, setMemoryReview] = useState<MemoryReviewSettings>(DEFAULT_MEMORY_REVIEW);
  const [memoryStatus, setMemoryStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [memorySaving, setMemorySaving] = useState(false);

  const apply = useCallback((s: SchedulerSettings) => {
    setPrivateSec(String(Math.round(Number(s.privateWakeMs) / 1000)));
    setGroupSec(String(Math.round(Number(s.groupWakeMs) / 1000)));
    setTaskSec(String(Math.round(Number(s.taskWakeMs) / 1000)));
  }, []);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    setMemoryStatus({ text: "加载中…" });
    try {
      const [s, m] = await Promise.all([
        request<SchedulerSettings>("/v1/scheduler"),
        request<MemoryReviewSettings>("/v1/memory-review"),
      ]);
      apply(s);
      setMemoryReview(m);
      setStatus({ text: "" });
      setMemoryStatus({ text: "" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      setMemoryStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
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

  const saveMemoryReview = async () => {
    setMemorySaving(true);
    setMemoryStatus({ text: "保存中…" });
    try {
      setMemoryReview(
        await request<MemoryReviewSettings>("/v1/memory-review", {
          method: "PUT",
          body: memoryReview,
        }),
      );
      setMemoryStatus({ text: "已保存并生效" });
    } catch (e) {
      setMemoryStatus({ text: `保存失败：${friendlyError(e)}`, error: true });
    } finally {
      setMemorySaving(false);
    }
  };

  return (
    <>
      <Card>
        <CardHead>
          <CardTitle>唤醒间隔</CardTitle>
        </CardHead>
        <CardBody>
          <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
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
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardHead>
          <CardTitle>后台记忆梳理</CardTitle>
        </CardHead>
        <CardBody>
          <p className="mb-3 text-sm text-muted">
            到点后另起一个只带 `memory` 工具的会话，把最近的对话里值得留下的事实整理出来。技能和业务关系不走这里。默认关闭。
          </p>
          <div className="grid grid-cols-[minmax(120px,220px)_minmax(180px,300px)] gap-3 max-[820px]:grid-cols-1">
            <Field label="总开关">
              <Select
                value={memoryReview.enabled ? "on" : "off"}
                onValueChange={(value) => setMemoryReview((x) => ({ ...x, enabled: value === "on" }))}
                options={[
                  { value: "off", label: "关闭" },
                  { value: "on", label: "开启" },
                ]}
                ariaLabel="后台记忆梳理总开关"
              />
            </Field>
            <Field label="每 N 个用户回合">
              <Input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={memoryReview.everyTurns}
                onChange={(e) => setMemoryReview((x) => ({ ...x, everyTurns: Number(e.target.value) }))}
              />
            </Field>
            <Field label="最小间隔（秒）">
              <Input
                type="number"
                min={30}
                max={86400}
                step={1}
                value={memoryReview.minIntervalSec}
                onChange={(e) => setMemoryReview((x) => ({ ...x, minIntervalSec: Number(e.target.value) }))}
              />
            </Field>
          </div>
          <div className="my-3">
            <Button variant="primary" disabled={memorySaving} onClick={() => void saveMemoryReview()}>
              {memorySaving ? "保存中…" : "保存"}
            </Button>
          </div>
          <StatusText text={memoryStatus.text} error={memoryStatus.error} />
        </CardBody>
      </Card>
    </>
  );
}
