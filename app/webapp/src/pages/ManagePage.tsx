import type { ManageView } from "../lib/router.ts";
import { SideNav, SideNavGroup, SideNavItem } from "../components/SideNav.tsx";
import { UsersView } from "./manage/UsersView.tsx";
import { PersonaView } from "./manage/PersonaView.tsx";
import { ExecutorsView } from "./manage/ExecutorsView.tsx";
import { SettingsView } from "./manage/SettingsView.tsx";
import { UsageView } from "./manage/UsageView.tsx";
import { TaskStatsView } from "./manage/TaskStatsView.tsx";
import { SkillsView } from "./manage/SkillsView.tsx";
import { SchedulesView } from "./manage/SchedulesView.tsx";
import { LlmLogsView } from "./manage/LlmLogsView.tsx";
import { ModelsView } from "./manage/ModelsView.tsx";
import { WorkingMemoryView } from "./manage/WorkingMemoryView.tsx";
import { BotsView } from "./manage/BotsView.tsx";

const LABELS: Record<ManageView, string> = {
  usage: "用量统计",
  "task-stats": "任务统计",
  "llm-logs": "模型日志",
  bots: "机器人管理",
  executors: "本地编程工具",
  models: "对话模型",
  users: "用户别名",
  schedules: "日程管理",
  settings: "调度开关",
  skills: "技能",
  persona: "提示词编辑",
  "work-memory": "工作记忆",
};

const HINTS: Record<ManageView, string> = {
  usage: "按模型和调用看 token 与费用；区间由前端筛选。",
  "task-stats": "已完成任务的耗时、token 与费用。",
  "llm-logs": "按会话看实际请求 / 响应；长正文先折叠。",
  bots: "已接入的 IM 机器人；点条目查看连接健康、入站计数、漏收核对与凭据。",
  models: "配置多个备用模型；手动切换后下一轮唤醒用新模型重建会话。",
  persona: "人设与提示词；保存后下一轮生效。",
  users: "别名优先于通讯录名字；保存后回填。任务 CLI 用户已隐藏。",
  schedules: "cron 重复 / N 分钟后一次；到点写入日程池。",
  settings: "唤醒间隔单位：秒；日额度按调用 / token / 元三条闸；上下文交接可选 60k～800k，保存后下一轮生效。",
  executors: "选择新建任务默认使用的本地编程工具，查看安装状态与版本。",
  skills: "只读：只做发现，不在管理台改技能内容。",
  "work-memory": "只读：跨会话共享的 memory.md；写入仍走 Agent 的 working_memory 工具。",
};

const MANAGE_GROUPS: { label: string; views: ManageView[] }[] = [
  { label: "观测", views: ["usage", "task-stats", "llm-logs"] },
  {
    label: "配置",
    views: ["bots", "models", "persona", "settings", "schedules", "executors", "users"],
  },
  { label: "只读", views: ["skills", "work-memory"] },
];

export function ManagePage({
  view,
  bot,
  onViewChange,
  onBotChange,
  reloadSignal,
}: {
  view: ManageView;
  bot?: string;
  onViewChange: (view: ManageView) => void;
  onBotChange: (bot?: string) => void;
  reloadSignal: number;
}) {
  return (
    <div className="flex h-full min-h-0 max-[820px]:flex-col">
      <SideNav ariaLabel="管理范围">
        {MANAGE_GROUPS.map((group) => (
          <SideNavGroup key={group.label} label={group.label}>
            {group.views.map((item) => (
              <SideNavItem
                key={item}
                active={view === item}
                onClick={() => onViewChange(item)}
                label={LABELS[item]}
              />
            ))}
          </SideNavGroup>
        ))}
      </SideNav>
      <div className="rb-thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-[clamp(14px,3vw,34px)] pb-12 pt-5 max-[820px]:px-3.5 max-[820px]:pb-10 max-[820px]:pt-3">
        <div className="mb-3.5">
          <h1 className="rb-display m-0 text-[22px] leading-tight">{LABELS[view]}</h1>
          <p className="mt-1 max-w-[62ch] text-[11.5px] leading-relaxed text-muted">
            {HINTS[view]}
          </p>
        </div>
        {view === "usage" && <UsageView reloadSignal={reloadSignal} />}
        {view === "task-stats" && <TaskStatsView reloadSignal={reloadSignal} />}
        {view === "llm-logs" && <LlmLogsView reloadSignal={reloadSignal} />}
        {view === "bots" && (
          <BotsView bot={bot} onOpen={onBotChange} reloadSignal={reloadSignal} />
        )}
        {view === "models" && <ModelsView reloadSignal={reloadSignal} />}
        {view === "users" && <UsersView reloadSignal={reloadSignal} />}
        {view === "persona" && <PersonaView reloadSignal={reloadSignal} />}
        {view === "schedules" && <SchedulesView reloadSignal={reloadSignal} />}
        {view === "executors" && <ExecutorsView reloadSignal={reloadSignal} />}
        {view === "settings" && <SettingsView reloadSignal={reloadSignal} />}
        {view === "skills" && <SkillsView reloadSignal={reloadSignal} />}
        {view === "work-memory" && <WorkingMemoryView reloadSignal={reloadSignal} />}
      </div>
    </div>
  );
}