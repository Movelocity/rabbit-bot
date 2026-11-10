---
name: rabbit-bot
description: rabbit-bot 项目技能组索引。处理业务地图、UFA/WA 任务、提示词/人设、rabbit-bot 运维时先读本索引，再按读者读子技能。
---

# rabbit-bot 项目技能组

完整技能组在 `{{SKILL_LIBRARY}}`。本文件只是索引，子技能不要放在这里，避免扫描器递归发现多份 `SKILL.md`。

## 子技能

子技能按读者分前缀：`ufa-` 给只读的 UFA，`wa-` 给执行改动的 WA。

| 子技能 | 读者 | 什么时候用 | 入口 |
|---|---|---|---|
| `ufa-business-map` | UFA | 查业务地图、解释关系、算影响面、判断该不该派活 | `{{SKILL_LIBRARY}}/ufa-business-map/SKILL.md` |
| `wa-business-map` | WA | 新增/修改业务地图、校验、汇报 | `{{SKILL_LIBRARY}}/wa-business-map/SKILL.md` |

先完整读对应子技能的 `SKILL.md`，再按里面的步骤做。

## 其他路由

- 人设/提示词 → `app/README.md` 的「定制它」；运行时优先，仓库默认份在 `app/prompts/` 和 `app/config/persona.md`
- 任务/审批/worker → `app/prompts/system.md`、`docs/SPEC-*`
- 运维排障 → `app/scripts/doctor.sh`、`app/logs/app.log`、`app/scripts/run.sh`
