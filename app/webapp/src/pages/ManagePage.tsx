import { cx } from "../lib/cx.ts";
import { MANAGE_VIEWS, type ManageView } from "../lib/use-url-state.ts";
import { UsersView } from "./manage/UsersView.tsx";
import { PersonaView } from "./manage/PersonaView.tsx";
import { SettingsView } from "./manage/SettingsView.tsx";
import { UsageView } from "./manage/UsageView.tsx";
import { TaskStatsView } from "./manage/TaskStatsView.tsx";
import { SkillsView } from "./manage/SkillsView.tsx";
import { SchedulesView } from "./manage/SchedulesView.tsx";
import { LlmLogsView } from "./manage/LlmLogsView.tsx";

const LABELS: Record<ManageView, string> = {
  usage: "用量",
  "task-stats": "任务统计",
  "llm-logs": "模型日志",
  persona: "提示词编辑",
  users: "用户",
  schedules: "日程",
  settings: "调度",
  skills: "技能",
};

export function ManagePage({
  view,
  onViewChange,
  reloadSignal,
}: {
  view: ManageView;
  onViewChange: (view: ManageView) => void;
  reloadSignal: number;
}) {
  return (
    <div className="grid h-full grid-cols-[200px_minmax(0,1fr)] min-h-0 max-[820px]:grid-cols-1 max-[820px]:grid-rows-[auto_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-border bg-surface p-3.5 max-[820px]:flex-row max-[820px]:overflow-x-auto max-[820px]:overflow-y-hidden max-[820px]:border-b max-[820px]:border-r-0 max-[820px]:px-3 max-[820px]:py-2">
        {MANAGE_VIEWS.map((item) => (
          <button
            key={item}
            type="button"
            className={cx(
              "w-full rounded-lg px-3 py-2 text-left text-muted transition hover:bg-surface2 max-[820px]:w-auto max-[820px]:whitespace-nowrap",
              view === item && "bg-accent-soft font-semibold text-accent",
            )}
            aria-current={view === item ? "page" : undefined}
            onClick={() => onViewChange(item)}
          >
            {LABELS[item]}
          </button>
        ))}
      </aside>
      <div className="min-h-0 overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
        {view === "usage" && <UsageView reloadSignal={reloadSignal} />}
        {view === "task-stats" && <TaskStatsView reloadSignal={reloadSignal} />}
        {view === "llm-logs" && <LlmLogsView reloadSignal={reloadSignal} />}
        {view === "users" && <UsersView reloadSignal={reloadSignal} />}
        {view === "persona" && <PersonaView reloadSignal={reloadSignal} />}
        {view === "schedules" && <SchedulesView reloadSignal={reloadSignal} />}
        {view === "settings" && <SettingsView reloadSignal={reloadSignal} />}
        {view === "skills" && <SkillsView reloadSignal={reloadSignal} />}
      </div>
    </div>
  );
}
