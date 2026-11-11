import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../lib/api-context.tsx";
import { friendlyError } from "../../lib/format.ts";
import { usePolling } from "../../lib/use-polling.ts";
import type { Schedule, ScheduleKind, ScheduleStatus } from "../../lib/types.ts";
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
  Textarea,
} from "../../components/ui.tsx";

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "cancelled", label: "已取消" },
  { value: "done", label: "已完成" },
];

const STATUS_LABEL: Record<ScheduleStatus, string> = {
  active: "进行中",
  cancelled: "已取消",
  done: "已完成",
};

const KIND_OPTIONS = [
  { value: "cron", label: "cron 重复" },
  { value: "delay", label: "N 分钟后一次" },
];

function statusVariant(status: ScheduleStatus) {
  if (status === "active") return "info" as const;
  if (status === "done") return "done" as const;
  if (status === "cancelled") return "closed" as const;
  return "default" as const;
}

function whenLabel(s: Schedule): string {
  if (s.kind === "cron") return `cron ${s.cron ?? ""}`;
  return `创建后 ${s.delay_minutes ?? 0} 分钟`;
}

export function SchedulesView({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Schedule[]>([]);
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("cron");
  const [cron, setCron] = useState("");
  const [delayMinutes, setDelayMinutes] = useState("10");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStatus({ text: "加载中…" });
      try {
        const data = await request<Schedule[]>(
          `/v1/schedules?status=${encodeURIComponent(filter)}`,
        );
        setRows(data);
        setStatus({ text: "" });
      } catch (e) {
        setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
      }
    },
    [request, filter],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  usePolling(() => load(true), 5000);

  const submitCreate = async () => {
    const text = content.trim();
    if (!text) {
      setStatus({ text: "content 不能为空：到点要带给 agent 的话。", error: true });
      return;
    }
    const body: Record<string, unknown> = {
      title: title.trim() || undefined,
      content: text,
      kind,
    };
    if (kind === "cron") {
      if (!cron.trim()) {
        setStatus({ text: "cron 日程要填 cron 表达式。", error: true });
        return;
      }
      body.cron = cron.trim();
    } else {
      const minutes = Number(delayMinutes);
      if (!Number.isInteger(minutes) || minutes < 1) {
        setStatus({ text: "delay_minutes 要是 ≥1 的整数。", error: true });
        return;
      }
      body.delay_minutes = minutes;
    }
    setBusy(true);
    setStatus({ text: "保存中…" });
    try {
      const created = await request<Schedule>("/v1/schedules", { method: "POST", body });
      setCreating(false);
      setTitle("");
      setContent("");
      setCron("");
      setDelayMinutes("10");
      setStatus({ text: `已创建日程 #${created.id}，下次 ${created.next_at_local}` });
      await load(true);
    } catch (e) {
      setStatus({ text: `新建失败：${friendlyError(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (s: Schedule) => {
    try {
      await request<Schedule>(`/v1/schedules/${s.id}`, { method: "DELETE" });
      setStatus({ text: `已取消日程 #${s.id}` });
      await load(true);
    } catch (e) {
      setStatus({ text: `取消失败：${friendlyError(e)}`, error: true });
    }
  };

  return (
    <>
      <div className="my-3 flex flex-wrap items-end gap-3">
        <Field label="状态" compact>
          <Select value={filter} onValueChange={setFilter} options={STATUS_OPTIONS} ariaLabel="日程状态" />
        </Field>
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? "取消" : "新建日程"}
        </Button>
      </div>

      {creating && (
        <Card className="mb-3">
          <CardHead>
            <CardTitle>新建日程</CardTitle>
          </CardHead>
          <CardBody className="grid gap-3">
            <div className="grid grid-cols-[minmax(140px,200px)_minmax(0,1fr)] gap-3 max-[820px]:grid-cols-1">
              <Field label="类型">
                <Select
                  value={kind}
                  onValueChange={(v) => setKind(v as ScheduleKind)}
                  options={KIND_OPTIONS}
                  ariaLabel="日程类型"
                />
              </Field>
              <Field label={kind === "cron" ? "cron 表达式（分 时 日 月 周，Asia/Shanghai）" : "创建后多少分钟触发"}>
                {kind === "cron" ? (
                  <Input
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                    placeholder="0 9 * * *  = 每天 9:00；0 9 * * 1 = 每周一 9:00"
                  />
                ) : (
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={delayMinutes}
                    onChange={(e) => setDelayMinutes(e.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field label="标题（可选）">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="短标题，不填就用内容截断" />
            </Field>
            <Field label="到点要说的话">
              <Textarea
                rows={3}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="例：提醒他周五下班前交周报"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setCreating(false)} disabled={busy}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={() => void submitCreate()} disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <StatusText text={status.text} error={status.error} />

      <div className="grid gap-2.5">
        {!rows.length ? (
          <Empty>没有日程。新建一条，或者让机器人在聊天里建。</Empty>
        ) : (
          rows.map((s) => (
            <Card key={s.id}>
              <CardHead>
                <CardTitle>
                  <span className="font-mono text-[13px] font-semibold text-muted">#{s.id}</span>{" "}
                  {s.title}
                </CardTitle>
                <Badge variant={statusVariant(s.status)}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
              </CardHead>
              <CardMeta>
                <span>{whenLabel(s)}</span>
                <span>下次 {s.next_at_local}</span>
                {s.last_fired_at_local && <span>上次 {s.last_fired_at_local}</span>}
              </CardMeta>
              <CardBody>
                <div className="whitespace-pre-wrap text-sm">{s.content}</div>
              </CardBody>
              {s.status === "active" && (
                <CardBody className="flex justify-end">
                  <Button size="sm" variant="danger" onClick={() => void cancel(s)}>
                    取消日程
                  </Button>
                </CardBody>
              )}
            </Card>
          ))
        )}
      </div>
    </>
  );
}
