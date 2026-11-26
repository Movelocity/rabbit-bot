# 管理台站点地图（webapp IA）

> 新增或调整前端页面前，**先改这份文档**，确认位置后再写代码。
> 实现：`app/webapp/src/lib/router.ts`（URL ↔ Route 的唯一入口）。

## 导航规则

1. **顶部 tab = 一类对象**。新功能优先放进已有 tab，不新增顶部 tab。
2. **二级导航只有两种形态**：
   - 条目 ≥ 3 或是动态列表 → 左侧栏 `SideNav`（可分组，组标题用 `SideNavGroup`）。
   - 恰好 2 个并列视图 → 页面顶部 `Segmented`。
   - 不用步骤条、编号、箭头表示并列视图。
3. **最多两层导航**：顶部 tab → 二级视图。再往下只允许**筛选**（状态、搜索、分页）和**详情**（选中条目），不再嵌套第三层视图切换。详情内部的分段（如任务的 详情/事件/产出）属于详情内容，不算导航层。
4. **同一个动作只放一个主入口**。其他地方出现时要么能就地完成（如概览直接批准），要么深链到具体条目，不能只跳到某个 tab 让用户再找。
5. **说明文字每页只出现一次**：页面标题下最多一句。不加底部提示栏，不加英文 eyebrow。
6. **URL 只由 router 写**。页面不得直接调用 `history.pushState/replaceState` 或监听 `popstate`。用户主动跳转用 push；挂载时规范化 URL 用 replace；筛选条件不进 URL。

## 页面结构

| 顶部 tab | `tab=` | 二级（`view=`） | 形态 | 详情 / 参数 |
|---|---|---|---|---|
| 概览 | `overview` | — | — | 「需要你处理」可就地批准/拒绝，点条目深链到审批 |
| 会话 | `chat` | — | — | — |
| 工作台 | `work` | `tasks` 全部任务 · `outputs` 产出文件 · `project` 单个项目（侧栏按 推进中/计划中/已完成 分组列出） | SideNav | `task=<id>` 任务详情（叠加在当前 view 上）；`slug=` 项目；`path=` 产出文件 |
| 权限 | `approvals` | `pending` 审批（默认） · `reads` 读取记录（白名单与规则在抽屉里） | Segmented | `id=<approvalId>` 选中审批 |
| 记忆 | `memories` | `entries` 条目（默认） · `graph` 图谱 | Segmented | — |
| 管理 | `manage` | 观测：`usage` `task-stats` `llm-logs`；配置：`models` `persona` `settings` `schedules` `executors` `users`；只读：`skills` `work-memory` | SideNav（分组） | — |

## URL 示例

```
/?tab=work&view=tasks
/?tab=work&view=tasks&task=12
/?tab=work&view=project&slug=foo&task=12   # 从项目进入的任务，返回回到项目
/?tab=work&view=outputs&path=tasks/12/report.md
/?tab=approvals&view=pending&id=7
/?tab=memories&view=graph
/?tab=manage&view=llm-logs
```

旧链接（`tab=tasks|outputs|projects|plans|business|users…`、`scope=…`、`from=…`）由 `parseRoute` 兼容，挂载时 replace 成新格式。
