# rabbit-bot

一个跑在飞书上的聊天 Agent。**池子就是上下文**——它没有会话记忆，每一轮都从池子里读最近的对话和记忆文件，然后决定说不说、说什么。

设计原则：调度、去重、游标、预算这些**全是确定性代码**；模型只负责一件事——说话。

## 快速开始

```bash
npm install
npm run build

mkdir -p ~/.config/rabbit-bot && cat > ~/.config/rabbit-bot/env <<'EOF'
DEEPSEEK_API_KEY=...
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
RABBIT_BOT_INJECT_TOKEN=$(openssl rand -hex 24)   # 本地注入口用，必须设
EOF
chmod 600 ~/.config/rabbit-bot/env

pm2 start ecosystem.config.cjs     # 用 pm2，别同时手工 run.sh（会起两个进程抢消息）
npm run doctor                     # 体检：进程 / 锁 / 注入口 / 沙盒 / 唤醒分布
```

缺任一凭据进程会 `exit 2` 不启动；已经有实例在跑会 `exit 3`。

## 怎么和它说话

| 方式 | 命令 |
|---|---|
| 飞书私聊 / 群里 @ | 直接发 |
| 本地注入（绕过飞书） | `npm run inject -- "在吗"` |

## 目录

```
src/core/        调度器、消息池、计划、循环守卫、读图、沙盒文件区、容器沙盒
src/agent/       pi 会话封装（engine）、工具定义（tools）、提示词（prompt）
src/adapters/    飞书 / mock（sim 与测试用）
src/ctl.ts       运维命令（pause / resume / status / usage / wakes / plans …）
scripts/         run.sh（pm2 的前台入口：读 env → 预检 → exec node）、doctor.sh（体检）、inject.sh（注入）、sbx.sh（沙盒容器）
docker/          沙盒镜像 Dockerfile
test/            257 条，node --test
data/            运行时数据（db / media / sandbox / 会话），.gitignore
```

## 工具清单（模型能调的 4 个）

`send` `stay_silent` `view_image` `rb`

`send` 是唯一对外出口。`rb` 是唯一的业务通道：命令在 Docker 沙盒里跑（`/usr/local/bin/rb`），
业务数据（池/计划/记忆/图片/联网/技能）走宿主 REST API，文件和 shell 直接操作 `/work`，
碰不到宿主文件系统。见 [docs/sandbox-api.md](docs/sandbox-api.md)。

## 文档

- [docs/OPERATIONS.md](docs/OPERATIONS.md) —— 运维命令全表、故障排查
- [docs/NOTES.md](docs/NOTES.md) —— 踩过的坑和当时的判断
- [DEPLOY.local.md](DEPLOY.local.md) —— 这台机器上的部署事实（端口、路径、容器参数、自启）
