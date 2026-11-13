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

const HINTS: Record<ManageView, string> = {
  usage: "按模型和调用看 token 与费用；区间由前端筛选。",
  "task-stats": "已完成任务的耗时、token 与费用。",
  "llm-logs": "按会话看实际请求 / 响应；长正文先折叠。",
  persona: "人设与提示词；保存后下一轮生效。",
  users: "别名优先于通讯录名字；保存后回填。",
  schedules: "cron 重复 / N 分钟后一次；到点写入日程池。",
  settings: "单位：秒；保存后立即生效。",
  skills: "只读：只做发现，不在管理台改技能内容。",
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
    <div className="grid h-full min-h-0 grid-cols-[190px_minmax(0,1fr)] max-[820px]:grid-cols-1 max-[820px]:grid-rows-[auto_minmax(0,1fr)]">
      <aside className="rb-thin-scroll flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-surface p-2.5 max-[820px]:flex-row max-[820px]:overflow-x-auto max-[820px]:overflow-y-hidden max-[820px]:border-b max-[820px]:border-r-0 max-[820px]:px-3 max-[820px]:py-2">
        {MANAGE_VIEWS.map((item) => (
          <button
            key={item}
            type="button"
            className={cx(
              "w-full rounded-[8px] px-2.5 py-2 text-left text-[12.5px] text-muted transition hover:bg-surface2 hover:text-text max-[820px]:w-auto max-[820px]:whitespace-nowrap",
              view === item && "bg-accent-soft font-bold text-accent-ink",
            )}
            aria-current={view === item ? "page" : undefined}
            onClick={() => onViewChange(item)}
          >
            {LABELS[item]}
          </button>
        ))}
      </aside>
      <div className="rb-thin-scroll min-h-0 overflow-y-auto px-[clamp(14px,3vw,34px)] pb-12 pt-5 max-[820px]:px-3.5 max-[820px]:pb-10 max-[820px]:pt-3">
        <div className="mb-3.5">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">Manage</div>
          <h1 className="rb-display m-0 mt-0.5 text-[22px] leading-tight">{LABELS[view]}</h1>
          <p className="mt-1 max-w-[62ch] text-[11.5px] leading-relaxed text-muted">
            {HINTS[view]}
          </p>
        </div>
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
