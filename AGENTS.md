# AGENTS.md

## 项目概要

rabbit-bot 是一个多 IM 聊天池 Agent（pi + 飞书 / Matrix / mock）。用户消息先入池，由调度器按 tick、私聊去抖、群里被 @、日程到点唤醒 Agent；确定性逻辑用普通代码实现，只在需要时调用 LLM。需求以 `需求文档.md` 为准。

代码主要在 `app/`：

- `app/src/`：后端（适配器、聊天池、调度、pi 引擎、工具、管理 API）
- `app/webapp/`：管理台前端（React 19 + TypeScript + Tailwind + React Flow）
- `app/web/`：前端构建产物，由后端直接托管
- `app/test/`：Node 原生 test runner
- `docs/`、`skills/`：设计文档与技能

## 常用命令

在 `app/` 下执行：

```bash
npm test              # 后端测试
npm run typecheck     # 后端类型检查
npm run build         # 后端编译到 dist/
npm run web:typecheck # 前端类型检查
npm run web:build     # 前端构建，产物写入 app/web/
npm run start:dev     # 用 tsx 直接跑后端
```

## 本地浏览器测试

- 管理台入口是 `http://localhost:3738/`（根路径，参数直接挂后面，例如 `http://localhost:3738/?tab=work&scope=tasks`）。
- **不要用 `127.0.0.1`**：登录态存在 localStorage（`rabbit-bot.api-token`）并按 origin 隔离，换 host 会变成未登录。
- **不要用 `/ui/`**：该路径会返回 401；静态页面只走根路径 `/`。

## 改动后的构建要求

- **前端（`app/webapp/src/`）改完必须重新构建**：`npm run web:build`，把产物写到 `app/web/`。只跑 typecheck 不会更新线上页面。
- **后端（`app/src/`）改完必须 `npm run build`**，再 `pm2 restart rabbit-bot`；`pm2 restart` 不会编译。
- 只改 `app/config/prompt/*.md` 时 `pm2 restart` 即可。
- 改完前端或后端，至少跑对应的 typecheck（`npm run typecheck` / `npm run web:typecheck`）；涉及后端逻辑时跑 `npm test`。
- 代码和测试不得出现真实人名
