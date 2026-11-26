import { useMemo, useState } from "react";
import { cx } from "../../lib/cx.ts";
import { formatTs } from "../../lib/format.ts";
import type { TaskView } from "../../lib/types.ts";
import { STATUS_GROUPS, STATUS_LABEL, statusGroupOf, type StatusGroupKey } from "./shared.ts";

const RANK: Record<StatusGroupKey, number> = { pending: 0, blocked: 1, running: 2, done: 3 };

/** 项目内任务：一条任务一行，按待处理优先排序，方便扫读，不用看板。 */
export function ProjectTasks({
  tasks,
  outputCounts,
  emptyHint,
  onOpenTask,
}: {
  tasks: TaskView[];
  outputCounts: Map<number, number>;
  emptyHint: string;
  onOpenTask: (id: number) => void;
}) {
  const [filter, setFilter] = useState<"" | StatusGroupKey>("");

  const counts = useMemo(() => {
    const c: Record<StatusGroupKey, number> = { pending: 0, running: 0, blocked: 0, done: 0 };
    for (const t of tasks) c[statusGroupOf(t.status)]++;
    return c;
  }, [tasks]);

  const groups = STATUS_GROUPS.filter((g) => counts[g.key] > 0);

  const rows = useMemo(() => {
    return [...tasks]
      .filter((t) => !filter || statusGroupOf(t.status) === filter)
      .sort(
        (a, b) =>
          RANK[statusGroupOf(a.status)] - RANK[statusGroupOf(b.status)] ||
          b.updated_at - a.updated_at ||
          b.id - a.id,
      );
  }, [tasks, filter]);

  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[13px] font-semibold">关联任务</h2>
        <span className="text-[11px] tabular-nums text-faint">{tasks.length}</span>
        {groups.length > 1 ? (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <FilterChip active={filter === ""} label="全部" n={tasks.length} onClick={() => setFilter("")} />
            {groups.map((g) => (
              <FilterChip
                key={g.key}
                active={filter === g.key}
                label={g.title}
                n={counts[g.key]}
                onClick={() => setFilter(filter === g.key ? "" : g.key)}
              />
            ))}
          </div>
        ) : null}
      </div>

      {!rows.length ? (
        <p className="m-0 rounded-[10px] border border-dashed border-border px-3 py-6 text-center text-[12px] text-faint">
          {tasks.length ? "没有匹配的任务。" : emptyHint}
        </p>
      ) : (
        <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-surface p-0">
          {rows.map((task) => {
            const status = statusGroupOf(task.status);
            const outputs = outputCounts.get(task.id) ?? 0;
            return (
              <li key={task.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition hover:bg-surface2 focus-visible:bg-surface2"
                  onClick={() => onOpenTask(task.id)}
                >
                  <span className={cx("size-1.5 flex-none rounded-full", DOT[status])} />
                  <span className="w-[46px] flex-none text-[11px] text-muted">
                    {STATUS_LABEL[task.status] || task.status}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-text">
                      {task.name || task.goal || "（无目标）"}
                    </span>
                    {task.name && task.goal ? (
                      <span className="block truncate text-[11px] text-muted">{task.goal}</span>
                    ) : null}
                  </span>
                  {task.stage ? (
                    <span className="hidden max-w-[120px] truncate rounded-[5px] border border-border bg-surface2 px-1.5 py-px font-mono text-[10px] text-muted min-[1100px]:inline">
                      {task.stage}
                    </span>
                  ) : null}
                  {outputs ? (
                    <span className="hidden flex-none text-[10.5px] tabular-nums text-faint min-[900px]:inline">
                      产出 {outputs}
                    </span>
                  ) : null}
                  <span className="w-[118px] flex-none whitespace-nowrap text-right text-[10.5px] tabular-nums text-faint">
                    {task.updated_at_local || formatTs(task.updated_at)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const DOT: Record<StatusGroupKey, string> = {
  pending: "bg-amber",
  running: "bg-accent",
  blocked: "bg-rose",
  done: "bg-line-strong",
};

function FilterChip({
  active,
  label,
  n,
  onClick,
}: {
  active: boolean;
  label: string;
  n: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cx(
        "rounded-full px-2 py-0.5 text-[11px] outline-none transition focus-visible:ring-2 focus-visible:ring-accent/35",
        active ? "bg-accent-soft font-semibold text-accent-ink" : "text-muted hover:bg-surface2 hover:text-text",
      )}
      onClick={onClick}
    >
      {label}
      <span className="ml-1 tabular-nums opacity-70">{n}</span>
    </button>
  );
}