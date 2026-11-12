---
name: rabbit-bot
description: rabbit-bot 项目技能组入口。处理 runtime/business 业务地图、UFA/WA 任务与审批、提示词/人设、rabbit-bot 仓库运维时先读本技能，再按路由进入子技能。
---

# rabbit-bot 项目技能组

这是项目级技能组，不是单个技能。先在这里判断任务属于哪一块，再完整读对应子技能的 `SKILL.md`。

## 子技能

子技能按读者分前缀：`ufa-` 给只读的 UFA，`wa-` 给执行改动的 WA。

| 子技能 | 读者 | 什么时候用 | 入口 |
|---|---|---|---|
| `ufa-business-map` | UFA | 查业务地图、解释关系、算影响面、判断该不该派活 | `ufa-business-map/SKILL.md` |
| `wa-business-map` | WA | 新增/修改业务地图、校验、汇报 | `wa-business-map/SKILL.md` |
| `business-relation-modeling` | UFA / WA / 人 | 设计/清洗/评审业务关系图，判断图是否健康，把文档或代码事实转成业务对象和关系 | `business-relation-modeling/SKILL.md` |
| `reporting` | UFA / WA | 写汇报、验收产出、他问「做完了没 / 结果在哪」 | `reporting/SKILL.md` |
| `product-manager` | UFA / WA / 人 | 需求说不清、判断这活能不能接、替项目把需求和验收定下来 | `product-manager/SKILL.md` |
| `project-manager` | UFA / WA / 人 | 项目既定、需求砍不掉、要拆解放进时间、排优先级、管风险、按周汇报 | `project-manager/SKILL.md` |

## 项目坐标

- 代码：`app/`；默认提示词：`app/prompts/`；默认人设：`app/config/persona.md`
- 运行时目录：`~/.config/rabbit-bot/runtime`（`RABBIT_BOT_RUNTIME` 可改）
- 业务地图：`<runtime>/business/`，不是仓库里的 `app/`
- 任务：`tasks` 表；worker 汇报在 `<runtime>/shared/task-<id>.md`
- **UFA ＝ 主 agent**，也就是 rabbit-bot 这个进程本身（用户看到的话都是它说的）；只读查地图（`map` 工具），不直接写 business
- **WA ＝ 本机 `opencode`**（任务表 `executor` 字段默认值，见 `app/src/core/dispatch.ts`）；执行任务，可用 `write_file` / `terminal` 改 business，高风险改动先报影响面等确认
- 两者不同进程、不共享上下文，交接只有任务文档 `.ufa/tasks/task-<id>.md` 和面板事件

## 路由

- 业务关系/对象/影响面 → UFA 读 `ufa-business-map/SKILL.md`；WA 读 `wa-business-map/SKILL.md`
- 设计/清洗/评审关系图，或判断图是否太碎 → 读 `business-relation-modeling/SKILL.md`
- 人设/提示词 → 读 `app/README.md` 的「定制它」；运行时优先，仓库默认份在 `app/prompts/` 和 `app/config/persona.md`
- 写汇报 / 验收 → 读 `reporting/SKILL.md`（`app/prompts/system.md` 里只留四段结构和五条硬规则）
- 需求澄清 / 验收标准 / 停损条件 / 该不该接活 → 读 `product-manager/SKILL.md`
- 项目拆解 / 排序 / 风险触发信号 / 进度按验收块算 → 读 `project-manager/SKILL.md`
- 任务/审批/worker → 读 `app/prompts/system.md`、`docs/SPEC-*`
- 运维排障 → `app/scripts/doctor.sh`、`app/logs/app.log`、`app/scripts/run.sh`

## 硬规则

- 读写流程按 `ufa-` / `wa-` 前缀区分读者；跨角色方法（如 `reporting`、`business-relation-modeling`）不分前缀。不要拿 `wa-` 的写流程给 UFA 用。
- 不猜关系。没有证据的对象/关系不进地图；拿不准就列「待确认」。
- 不在 UFA 里直接改 business；要改就建任务交给 WA。
- 不把密钥、token、密码写进业务地图；`source` 可以写路径或 URL。
- 改完必须验证：`map` 能查到，`business-map` 测试通过。
