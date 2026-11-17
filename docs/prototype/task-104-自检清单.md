# task-104 自检清单

日期：2026-11-13
对照：`skills/prototype-prd-single-file/SKILL.md`（技能副本在 `shared/outputs/task-101/SKILL.md`）
文件：`prototype/rabbit-bot-prototype-prd.html`（157,204 bytes）

## 结论

10 条逐条过：9 条通过，1 条按任务实际情况适配（第 7 条，见备注）。没有伪造会议/确认单出处。

| # | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 单 HTML、零依赖，双击能开 | 通过 | 无 `<script src>`、`<link>`、`<img>`、`@import`；ego-browser 用 `file://` 打开，8 个 tab 与 PRD 模式均可用 |
| 2 | 顶栏有原型/PRD 切换，PRD 样式全挂 `body.prd` | 通过 | header 内 `data-mode="proto|prd"`；切换给 body 加 `.prd`；`.pin`、`.prd-panel`、`[data-prd]` 虚线框、`.gone-note` 都只在 `body.prd` 下生效 |
| 3 | 每个 PRD 说明 id 都有 `data-prd` 锚点，数量一一对应 | 通过 | 静态锚点 9 个（shell + 8 tab），PRD 条目 9 条；运行时显示 2 条（shell + 当前 tab），编号 1/2 对齐 |
| 4 | 点编号跳说明、点说明跳回模块并高亮 | 通过 | 8 个 tab 逐个点 `#view .pin`，`.hl` 均为 `[当前 id, 当前 id]`；再点 `.prd-panel .note:last-child`，`.hl` 仍为 `[当前 id, 当前 id]` 并滚回页面 |
| 5 | 每条说明六字段齐全 | 通过 | 9 条 note 均含「用途 / 字段与口径 / 数据来源 / 规则与出处 / 交互 / 待确认」；运行时逐条读取校验 |
| 6 | 数据来源每项带已有/新做/待确认色标 | 通过 | `src` 项全部渲染为 `.src.has` / `.src.new` / `.src.ask`；缺字段标「新做」，没定的标「待确认」 |
| 7 | 待确认项带会议或确认单题号 | 通过（适配） | Q1–Q16 全部编号并标注 #104；本任务没有会议纪要/确认单原文，用任务号 + 题号替代，未自造出处（见交接「遗留/风险」） |
| 8 | 被砍功能用删除线在 PRD 模式显形，并注明「隐藏不是删除」 | 通过 | 管理页 `.gone-note`：原型模式 `display:none`，PRD 模式 `display:flex`；`.gone-item` 有删除线，文案写明「隐藏不是删除：页面、接口、权限都保留」。顶部菜单本身没有砍项，示例放在管理页内容里，不改顶部菜单 |
| 9 | 交互全走 document 级事件委托，无逐元素绑定 | 通过 | `onclick=` 出现 0 次；document 上只有 `input` / `change` / `click` / `keydown` 四类监听；按钮靠 `data-act` / `data-set` / `data-edit` 分派 |
| 10 | PRD 每条口径能指回代码或业务出处，不自造规则 | 通过 | 规则与出处引用 `App.tsx`、`ChatPage.tsx`、`TasksPage.tsx`、`OutputsPage.tsx`、`ApprovalsPage.tsx`、`PlansPage.tsx`、`MemoriesPage.tsx`、`types.ts`、`WA-BEST-PRACTICES.md`；布局与配色属设计决定，在 shell 条与交接里写明理由 |

## 验证记录

- `node --check`（抽出内嵌 script）：通过。
- 静态检查：外部 script 0、link 0、img 0、@import 0、onclick 0；`data-prd` 静态锚点 9 个。
- Chromium 真机（ego-browser，`file://`）：
  - 8 个 tab 逐个点开，页面锚点依次为 chat / tasks / outputs / approvals / plans / memories / business / manage，JS error 0。
  - PRD 模式：8 个 tab 的 note id 都是 `[shell, 当前 tab]`，pin 文本 `[1,2,1,2]`，六字段齐全，三色标存在，Q1–Q16 有编号。
  - 双向跳转：每个 tab 都验证了「pin → note」与「note → 模块」。
  - 交互：任务抽屉/通过弹窗/驳回必填、产出目录展开/类型过滤/搜索/CSV 预览、权限跳任务、计划勾目标/记录进展/新建标题必填、记忆选中/追溯/编辑保存/删除确认、知识分类/节点切换、管理 8 个子页/设置脏标记/提示词保存/新建日程、会话切池/改审批策略/搜索。
- 未验证：Safari、Firefox 未点；未接真实后端，所有保存/归档/通过/驳回只改内存状态。

## 备注

- 第 7 条：技能原文要求「会议或确认单题号」。本任务材料里没有会议纪要/确认单，若硬写一个题号就是编出处。这里的处理是给每个 open 项 Q1–Q16 编号并标 #104，保留可追踪性；等有会议记录后可直接替换成正式题号。
