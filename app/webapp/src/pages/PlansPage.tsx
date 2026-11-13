import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api-context.tsx";
import { cx } from "../lib/cx.ts";
import { badgeVariant, friendlyError } from "../lib/format.ts";
import type { Board } from "../lib/types.ts";
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Page,
  PageHead,
  Segmented,
  StatusText,
  Textarea,
} from "../components/ui.tsx";
import { Drawer } from "../components/Drawer.tsx";

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "done", label: "已完成" },
];

const STATUS_LABEL: Record<string, string> = { active: "进行中", done: "已完成", archived: "已归档" };

function percent(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

export function PlansPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [rows, setRows] = useState<Board[]>([]);
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [background, setBackground] = useState("");
  const [goalsText, setGoalsText] = useState("");
  const [formError, setFormError] = useState("");
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

  const closeCreate = () => {
    setCreating(false);
    setFormError("");
  };

  const submitCreate = async () => {
    const t = title.trim();
    if (!t) {
      setFormError("计划标题不能为空。");
      return;
    }
    setBusy(true);
    setFormError("");
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
      setFormError(`新建失败：${friendlyError(e)}`);
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
    <Page>
      <PageHead
        eyebrow="Plans"
        title="计划"
        sub="目标勾选和进展记录都在这里；新增/过期记忆走 IM，这里只做计划本身。"
        actions={
          <>
            <Segmented
              value={filter}
              options={STATUS_OPTIONS}
              onChange={setFilter}
              label="计划状态"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => (creating ? closeCreate() : setCreating(true))}
            >
              {creating ? "收起新建" : "新建计划"}
            </Button>
          </>
        }
      />

      <StatusText text={status.text} error={status.error} />

      {!rows.length ? (
        <Empty>没有计划。新建一条，或者让机器人在聊天里建。</Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(330px,1fr))] items-start gap-3">
          {rows.map((b) => {
            const done = b.goals_done ?? b.goals.filter((g) => g.done).length;
            const total = b.goals_total ?? b.goals.length;
            const ratio = percent(done, total);
            return (
              <article
                key={b.slug}
                className="rounded-[14px] border border-border bg-surface p-4 shadow-[var(--rb-shadow)]"
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="min-w-0 text-[14px] font-semibold wrap-anywhere">
                    <span className="mr-1 inline-block rounded-[5px] border border-border bg-surface2 px-1.5 py-px align-middle font-mono text-[10.5px] font-normal text-muted">
                      {b.slug}
                    </span>
                    {b.title}
                  </div>
                  <Badge variant={badgeVariant(b.status)}>
                    {STATUS_LABEL[b.status] ?? b.status}
                  </Badge>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
                  <span>
                    目标 {done}/{total}
                  </span>
                  <span>进展 {b.progress.length}</span>
                  <span>完成度 {ratio}%</span>
                </div>
                <div className="mb-1 mt-2.5 h-1.5 overflow-hidden rounded bg-surface3">
                  <i
                    className="block h-full rounded bg-accent transition-[width]"
                    style={{ width: `${ratio}%` }}
                  />
                </div>

                {b.background ? (
                  <p className="mb-0 mt-2.5 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">
                    {b.background}
                  </p>
                ) : null}

                <div className="mt-2.5 grid gap-1.5">
                  {b.goals.length === 0 ? (
                    <p className="m-0 text-[12.5px] text-muted">还没有目标。</p>
                  ) : (
                    b.goals.map((g, i) => (
                      <label
                        key={`${b.slug}-${i}`}
                        className="flex cursor-pointer items-start gap-2 text-[12.5px]"
                      >
                        <input
                          type="checkbox"
                          className="mt-[3px] size-3.5 flex-none accent-[var(--rb-accent)]"
                          checked={g.done}
                          onChange={() => void toggleGoal(b, i)}
                        />
                        <span className={cx("wrap-anywhere", g.done && "text-faint line-through")}>
                          {g.text}
                        </span>
                      </label>
                    ))
                  )}
                </div>

                {b.progress.length > 0 && (
                  <div className="mt-2.5 grid gap-1 text-[11.5px] text-muted">
                    {b.progress.slice(-3).map((p, i) => (
                      <div key={`${b.slug}-p-${i}`} className="flex gap-2">
                        {p.at_local && (
                          <span className="flex-none tabular-nums text-faint">
                            {p.at_local.slice(5, 16)}
                          </span>
                        )}
                        <span className="wrap-anywhere">{p.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="my-3 h-px bg-border" />
                <ProgressInput onSubmit={(note) => void addProgress(b, note)} />
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {b.status !== "done" && (
                    <Button variant="ghost" size="sm" onClick={() => void setBoardStatus(b, "done")}>
                      标完成
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void setBoardStatus(b, "archived")}>
                    归档
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {creating && (
        <Drawer title="新建计划" onClose={closeCreate}>
          <Field label="标题">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="一句话说清要做什么"
            />
          </Field>
          <div className="h-2.5" />
          <Field label="背景">
            <Textarea
              rows={4}
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              placeholder="为什么做、范围、约束、相关链接"
            />
          </Field>
          <div className="h-2.5" />
          <Field label="目标（一行一条）">
            <Textarea
              rows={4}
              value={goalsText}
              onChange={(e) => setGoalsText(e.target.value)}
              placeholder={"查 state\n回报结果"}
            />
          </Field>
          {formError ? (
            <p className="mt-2.5 text-[12.5px] text-bad" role="alert">
              {formError}
            </p>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={closeCreate} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submitCreate()} disabled={busy}>
              {busy ? "保存中…" : "保存计划"}
            </Button>
          </div>
        </Drawer>
      )}
    </Page>
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
