import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { badgeVariant, friendlyError } from "../lib/format.ts";
import type { Board } from "../lib/types.ts";
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
} from "../components/ui.tsx";

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "done", label: "已完成" },
];

const STATUS_LABEL: Record<string, string> = { active: "进行中", done: "已完成", archived: "已归档" };

export function PlansPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Board[]>([]);
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [background, setBackground] = useState("");
  const [goalsText, setGoalsText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const data = await request<Board[]>(`/v1/plans?status=${encodeURIComponent(filter)}`);
      setRows(data);
      setStatus({ text: "" });
    } catch (e) {
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  const submitCreate = async () => {
    const t = title.trim();
    if (!t) {
      setStatus({ text: "计划标题不能为空。", error: true });
      return;
    }
    setBusy(true);
    setStatus({ text: "保存中…" });
    try {
      await request("/v1/plans", {
        method: "POST",
        body: {
          title: t,
          background: background.trim(),
          goals: goalsText.split("\n").map((x) => x.trim()).filter(Boolean),
        },
      });
      setCreating(false);
      setTitle("");
      setBackground("");
      setGoalsText("");
      setStatus({ text: "" });
      await load();
    } catch (e) {
      setStatus({ text: `新建失败：${friendlyError(e)}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  const toggleGoal = async (b: Board, index: number) => {
    const goal = b.goals[index];
    if (!goal) return;
    try {
      await request(`/v1/plans/${encodeURIComponent(b.slug)}`, {
        method: "PATCH",
        body: { goal_check: { goal: index + 1, done: !goal.done } },
      });
      setStatus({ text: "" });
      await load();
    } catch (e) {
      setStatus({ text: `勾选失败：${friendlyError(e)}`, error: true });
    }
  };

  const setBoardStatus = async (b: Board, next: "done" | "archived") => {
    try {
      if (next === "archived") {
        await request(`/v1/plans/${encodeURIComponent(b.slug)}`, { method: "DELETE" });
      } else {
        await request(`/v1/plans/${encodeURIComponent(b.slug)}`, { method: "PATCH", body: { status: next } });
      }
      setStatus({ text: "" });
      await load();
    } catch (e) {
      setStatus({ text: `操作失败：${friendlyError(e)}`, error: true });
    }
  };

  const addProgress = async (b: Board, note: string) => {
    const text = note.trim();
    if (!text) return;
    try {
      await request(`/v1/plans/${encodeURIComponent(b.slug)}`, { method: "PATCH", body: { progress: text } });
      setStatus({ text: "" });
      await load();
    } catch (e) {
      setStatus({ text: `记录进展失败：${friendlyError(e)}`, error: true });
    }
  };

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      <div className="my-3 flex flex-wrap items-end gap-3">
        <Field label="状态" compact>
          <Select value={filter} onValueChange={setFilter} options={STATUS_OPTIONS} ariaLabel="计划状态" />
        </Field>
        <Button variant="primary" size="sm" onClick={() => setCreating((v) => !v)}>
          {creating ? "取消" : "新建计划"}
        </Button>
      </div>

      {creating && (
        <Card className="mb-3">
          <CardHead>
            <CardTitle>新建计划</CardTitle>
          </CardHead>
          <CardBody className="grid gap-3">
            <Field label="标题">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清要做什么" />
            </Field>
            <Field label="背景">
              <Textarea
                rows={3}
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                placeholder="为什么做、范围、约束、相关链接"
              />
            </Field>
            <Field label="目标（一行一条）">
              <Textarea
                rows={3}
                value={goalsText}
                onChange={(e) => setGoalsText(e.target.value)}
                placeholder={"查 state\n回报结果"}
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
          <Empty>没有计划。新建一条，或者让机器人在聊天里建。</Empty>
        ) : (
          rows.map((b) => (
            <Card key={b.slug}>
              <CardHead>
                <CardTitle>
                  <span className="font-mono text-[13px] font-semibold text-muted">{b.slug}</span> {b.title}
                </CardTitle>
                <Badge variant={badgeVariant(b.status)}>{STATUS_LABEL[b.status] ?? b.status}</Badge>
              </CardHead>
              <CardMeta>
                <Badge>{b.status === "active" ? "进行中" : STATUS_LABEL[b.status] ?? b.status}</Badge>
                <span>目标 {b.goals_done}/{b.goals_total}</span>
                <span>进展 {b.progress.length}</span>
                {b.updated_at_local && <span>更新 {b.updated_at_local}</span>}
              </CardMeta>
              {b.background && (
                <CardBody>
                  <div className="whitespace-pre-wrap text-sm text-muted">{b.background}</div>
                </CardBody>
              )}
              <CardBody className="grid gap-2">
                {b.goals.length === 0 ? (
                  <p className="m-0 text-sm text-muted">还没有目标。</p>
                ) : (
                  b.goals.map((g, i) => (
                    <label key={`${b.slug}-${i}`} className="flex cursor-pointer items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 flex-none accent-[var(--rb-accent)]"
                        checked={g.done}
                        onChange={() => void toggleGoal(b, i)}
                      />
                      <span className={g.done ? "text-muted line-through" : ""}>{g.text}</span>
                    </label>
                  ))
                )}
              </CardBody>
              {b.progress.length > 0 && (
                <CardBody>
                  <div className="grid gap-1 text-[13px]">
                    {b.progress.map((p, i) => (
                      <div key={`${b.slug}-p-${i}`} className="flex gap-2">
                        {p.at_local && <span className="flex-none text-muted tabular-nums">{p.at_local.slice(5, 16)}</span>}
                        <span className="wrap-anywhere">{p.text}</span>
                      </div>
                    ))}
                  </div>
                </CardBody>
              )}
              <CardBody className="grid gap-2">
                <ProgressInput onSubmit={(note) => void addProgress(b, note)} />
                <div className="flex flex-wrap gap-2">
                  {b.status !== "done" && (
                    <Button size="sm" onClick={() => void setBoardStatus(b, "done")}>
                      标完成
                    </Button>
                  )}
                  <Button size="sm" onClick={() => void setBoardStatus(b, "archived")}>
                    归档
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

function ProgressInput({ onSubmit }: { onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  const submit = () => {
    if (!note.trim()) return;
    onSubmit(note);
    setNote("");
  };
  return (
    <div className="flex gap-2">
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="追加一条进展"
      />
      <Button size="sm" onClick={submit} disabled={!note.trim()}>
        记录
      </Button>
    </div>
  );
}
