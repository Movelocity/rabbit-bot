# SPEC：管理台信息架构收敛（webapp IA）

目标：降低层级、统一导航形态、去重复入口和文字、收拢 URL 状态。目标结构以 `docs/SITEMAP-webapp.md` 为准，本文件是实现清单。

范围：只改 `app/webapp/src/`、新增一个测试 `app/test/webapp-router.test.ts`、`AGENTS.md` 加一行。**不改后端，不加依赖，不 git commit。**

---

## D. 路由收拢（先做，其余依赖它）

### D1. 新建 `app/webapp/src/lib/router.ts`

纯函数部分**不得**在模块顶层访问 `window`/`document`（会被 node 测试直接 import）。

```ts
export const TABS = ["overview","chat","work","approvals","memories","manage"] as const;
export type Tab = typeof TABS[number];
export const MANAGE_VIEWS = [/* 保持现有 11 个，顺序按 C 的分组：usage, task-stats, llm-logs, models, persona, settings, schedules, executors, users, skills, work-memory */] as const;
export type ManageView = typeof MANAGE_VIEWS[number];

export type WorkView = "tasks" | "outputs" | "project";
export type Route =
  | { tab: "overview" }
  | { tab: "chat" }
  | { tab: "work"; view: WorkView; slug?: string; path?: string; task?: number }
  | { tab: "approvals"; view: "pending" | "reads"; id?: number }
  | { tab: "memories"; view: "entries" | "graph" }
  | { tab: "manage"; view: ManageView };

export function parseRoute(search: string): Route;   // 容错：任何非法输入都落到合法 Route
export function formatRoute(route: Route): string;    // 返回 "?tab=...&..."，参数顺序固定：tab, view, slug, path, task, id
export function sameRoute(a: Route, b: Route): boolean;
```

规则：
- `work`：`view=project` 必须有非空 `slug`，否则降级为 `tasks`；`path` 只在 `outputs` 下保留；`task` 必须是正整数，可叠加在 `tasks` / `project` 上（在 `outputs` 下丢弃）。
- `approvals`：默认 `pending`；`id` 正整数，仅 `pending` 下保留。
- `memories`：默认 `entries`。`manage`：默认 `usage`，非法 view 落 `usage`。未知 tab 落 `overview`。
- **旧链接兼容**（全部在 `parseRoute` 里，其他地方删掉兼容代码）：
  - `tab=users|persona|schedules|settings|usage|task-stats|skills` → `manage` + 同名 view
  - `tab=manage&view=business`、`tab=business` → `memories` + `graph`
  - `tab=tasks|plans|projects` → `work/tasks`；`tab=outputs` → `work/outputs`（带 `path`）
  - `tab=work&scope=tasks|projects` → `work/tasks`；`scope=outputs` → `work/outputs`（带 `path`）；`scope=project:<slug>` → `work/project`；`scope=task:<id>` → `work` + `task=id`，view 由 `from` 决定（`from=project:<slug>` → `project`+slug，否则 `tasks`）
  - `tab=approvals&scope=approvals` → `pending`；`scope=log|rules` → `reads`

### D2. 新建 `app/webapp/src/lib/use-route.tsx`

- `RouteProvider` + `useRoute(): { route: Route; navigate(next: Route, opts?: { replace?: boolean }): void; back(fallback: Route): void }`
- 唯一的 `popstate` 监听在这里。挂载时把 `window.location.search` 解析后用 `replaceState` 规范化一次。
- `navigate` 默认 `pushState`；目标与当前 `sameRoute` 时不写历史。保留 `location.hash`。
- `back(fallback)`：如果本次会话内由 `navigate` push 过（用一个计数器，popstate 时同步减），调用 `history.back()`；否则 `navigate(fallback, { replace: true })`。
- 删除 `lib/use-url-state.ts`，所有引用改用 `useRoute`。

### D3. 页面改造

- `App.tsx`：用 `RouteProvider` 包裹；删除 `taskFocus` 状态和 `onFocusHandled`；`onOpenTask(id)` 一律 `navigate({ tab: "work", view: "tasks", task: id })`。
- `WorkPage.tsx`：删除 `scopeFromUrl` / `writeScope` / 自己的 popstate；从 `useRoute()` 读 route。侧栏点击用 `navigate(..., { replace: true })`（切换范围不堆历史，与现状一致），打开任务用 push。任务详情返回按钮：`back(去掉 task 的同一 route)`，返回文案由 route 推出（`tasks`→「全部任务」，`project`→项目标题）。`work/shared.ts` 里 `WorkScope`/`parseScope`/`scopeKey`/`scopeLabel` 删除或替换。
- `ApprovalsPage.tsx`：删除 `initialView`/`syncViewToUrl`；view 与选中 `id` 来自 route；点列表项 `navigate({...route, id}, { replace: true })`。
- `MemoryPage.tsx`：删除 `initialStep`；view 来自 route。
- 全仓 `grep -rE "pushState|replaceState|popstate|location\.search" app/webapp/src` 结果只能出现在 `lib/use-route.tsx`。

### D4. 测试 `app/test/webapp-router.test.ts`

用 `node:test` + `node:assert/strict`，`import { parseRoute, formatRoute } from "../webapp/src/lib/router.ts"`。至少覆盖：
- 每个 tab 的默认 view；非法 tab/view/task/id 的降级
- 上面列出的**每一条**旧链接映射
- `formatRoute(parseRoute(formatRoute(r)))` 往返稳定（对一组代表性 Route）
- `work/outputs` 丢弃 `task`；`work/project` 缺 slug 降级

---

## B. 去层级、去重复

### B1. 权限页（`ApprovalsPage.tsx` + `approvals/`）
- 二级只剩两个：`Segmented` 选项「审批（N 待处理）」/「读取记录」，**默认审批**。
- 审批视图里状态筛选默认「待处理」；若待处理为 0 则默认「全部」（只在首次加载时决定，之后尊重用户选择）。
- 读取记录视图：`HostReadLog` 为主体，右上角按钮「白名单与规则」打开 `components/Drawer.tsx` 抽屉，里面渲染 `HostReadRules`。`HostReadLog` 内「加白名单」成功后，若抽屉打开要刷新规则。
- 路由 `id` 存在时选中该审批（若在当前筛选下不可见，切到「全部」）。

### B2. 概览「需要你处理」（`OverviewPage.tsx`）
- 每行改为：点击行文本 → `navigate({ tab: "approvals", view: "pending", id })`；行尾两个小按钮「批准」「拒绝」，调用 `POST /v1/approvals/{id}/decide`，body `{ decision, by: "web" }`（同 ApprovalsPage 的 `decide`），完成后刷新概览数据；进行中禁用按钮，失败用现有的状态/错误展示方式。
- 删除 `onOpenApprovals` 只跳 tab 的用法（`onOpenTasks`、`onOpenLogs` 改为 `navigate`，Overview 内部直接用 `useRoute`，App 不再传这些回调）。

### B3. 记忆页（`MemoryPage.tsx`）
- 删除 `StepSwitch`（编号 + 箭头），换成 `Segmented`：「条目」/「图谱 只读」。仍通过 `header` / `viewSwitch` prop 传给子页。

### B4. 工作台侧栏（`WorkPage.tsx`）
- 删除「项目总览」入口和 `ProjectsOverview` 渲染；若 `ProjectPanel.tsx` 的 `ProjectsOverview` 不再被引用则删除它及只被它用到的代码。
- 侧栏「项目」区按 `projectGroup` 分三组小标题：推进中 / 计划中 / 已完成。「已完成」组默认折叠（点击组标题展开，状态只存组件内，不进 URL），组标题显示数量。
- 侧栏改用 D/C 中抽出的 `SideNav` 组件。

### B5. 删除重复文字
- `App.tsx`：删除 `TAB_HINTS`、`MANAGE_HINTS` 和底部 `<footer>`。
- 删除英文 eyebrow：`WorkHead` 的 `eyebrow`（「Task Pool」「Projects」）、`ManagePage` 的「Manage」。全仓 grep 确认没有别的同类 eyebrow（`uppercase tracking-` 的英文小标题）。
- 每页标题下最多一句说明。`ManagePage` 保留 `HINTS`（它是唯一一处）。

---

## C. 管理页分组 + 统一侧栏组件

### C1. 新建 `app/webapp/src/components/SideNav.tsx`
- 导出 `SideNav`（容器：宽屏左侧竖排，`max-[820px]` 变横向滚动，样式沿用现有 WorkPage 侧栏）、`SideNavItem`（props 同现有 `WorkPage` 的 `NavItem`：active/onClick/icon?/label/count?/alert?/title?）、`SideNavGroup`（组标题，可选 `collapsible` + `collapsed` + `onToggle` + `count`；窄屏下组标题隐藏，与现状一致）。
- `WorkPage` 和 `ManagePage` 都改用它；删除两处各自的按钮样式代码。

### C2. `ManagePage.tsx` 分组
- 观测：用量统计、任务统计、模型日志
- 配置：对话模型、提示词编辑、调度开关、日程管理、本地编程工具、用户别名
- 只读：技能、工作记忆
- 分组定义放在 `ManagePage.tsx` 一个常量数组里；`MANAGE_VIEWS` 顺序与之一致。

---

## E. 流程

- `AGENTS.md` 的「改动后的构建要求」上方新增一节：

```md
## 前端信息架构

- 新增或调整前端页面前，先更新 `docs/SITEMAP-webapp.md`，遵守其中的导航规则（最多两层导航、二级只用 SideNav / Segmented、URL 只由 `lib/router.ts` 写）。
```

---

## 完成标准（实现方自检，全部通过才算完成）

在 `app/` 下：

1. `npm run web:typecheck` 通过
2. `npm run typecheck` 通过
3. `npm test` 全部通过（含新的 `webapp-router.test.ts`）
4. `npm run web:build` 成功，产物写入 `app/web/`
5. `grep -rnE "pushState|replaceState|popstate|location\.search" webapp/src` 只命中 `lib/use-route.tsx`
6. `grep -rn "use-url-state\|TAB_HINTS\|MANAGE_HINTS\|StepSwitch\|ProjectsOverview\|scopeFromUrl\|writeScope\|syncViewToUrl\|Task Pool" webapp/src` 无结果
7. 代码和测试不出现真实人名

不要做：改后端、加依赖、改视觉主题/配色、重写与本 spec 无关的组件、`git commit`。

---

## 验收清单（验收方在浏览器 `http://localhost:3738/` 执行）

- [ ] 顶部 6 个 tab 正常；底部提示栏消失；无英文 eyebrow
- [ ] 工作台：侧栏无「项目总览」；项目分三组，已完成默认折叠；点任务进详情 → 浏览器后退回到列表；从项目进任务 → 返回按钮写项目名并回到项目
- [ ] 直接打开 `?tab=work&view=tasks&task=<id>`，返回按钮回全部任务（无历史时不跳出站点）
- [ ] 旧链接 `?tab=tasks`、`?tab=outputs`、`?tab=projects`、`?tab=work&scope=task:<id>&from=project:<slug>`、`?tab=business`、`?tab=users` 都落到正确页面且地址栏被规范化
- [ ] 权限：默认「审批」；读取记录页「白名单与规则」抽屉可增删；`?tab=approvals&scope=rules` 落到读取记录
- [ ] 概览：待处理审批可就地批准/拒绝；点文本深链到对应审批并选中
- [ ] 记忆：分段切换，无编号箭头；`?tab=memories&view=graph` 直接打开图谱
- [ ] 管理：侧栏三组；每个 view 可打开；窄屏（≤820px）侧栏横向滚动
- [ ] 跨 tab 前进/后退行为一致，无内容叠加
