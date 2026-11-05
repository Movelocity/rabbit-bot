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

## 定制它（人设 / 提示词 / 话题库）

默认只是个简单助手：`agent.name=小池`，人设一句「你是一个自然、简短、有分寸的聊天伙伴。」
性格留给玩家自己定——仓库里不存任何人的真身设定。

三样东西都可以换，放运行时目录（默认 `~/.config/rabbit-bot/runtime/`，环境变量 `RABBIT_BOT_RUNTIME` 可改）：

```bash
mkdir -p ~/.config/rabbit-bot/runtime
cp app/config/persona.example.md ~/.config/rabbit-bot/runtime/persona.md   # 然后改成你要的
```

| 路径 | 是什么 | 改完要不要重启 |
|---|---|---|
| `runtime/persona.md` | 人设正文，进 system prompt 的 `{{persona}}` | 要 |
| `runtime/prompt/` | 主提示词 + 三种场景剧本（`scene-*.md`） | 剧本不用，`system.md` 要 |
| `runtime/topics/` | 话题库，按块分（`rg` 搜、`read_file` 读） | 不用 |

规则只有一条：**运行时目录有就用它，没有才用仓库里的默认份。** 没有配置开关。仓库里的
`config/persona.example.md` 和 `data/sandbox/topics/` 是模板和空架子，clone 下来能直接跑。

容器里路径不变（`/work/prompt`、`/work/topics`），只是挂载源换成了运行时目录；
挂载变了进程启动时会重建容器。

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

## 工具清单（模型能调的 7 个）

| 工具 | 干什么 |
|---|---|
| `chat` | `send` 发消息（唯一对外出口）/ `skip` 这轮不回 / `view` 读图进上下文 / `list` 有哪些池 / `search` 翻原话 |
| `memory` | `recent` / `search` / `add` / `expire`（不再成立，关掉）/ `update`（就地订正）/ `help` |
| `plan` | `add` / `done` / `list` / `help` |
| `read_file` / `write_file` | 读写 `/work` 里的文件（整份覆盖；追加走 `terminal` 的 `>>`） |
| `terminal` | 在 Docker 沙盒里跑命令：列目录、`rg` 搜内容、算数（碰不到宿主文件系统） |
| `rb` | 只给运维和查询：`pool-*` / `plan-list` / `mem-search` / `img-*` / `web-*` / `skills`；业务写入会被挡住并指向对应工具 |

业务数据（池/计划/记忆/图片/联网/技能）走宿主 REST API，文件和 shell 落在 `/work`。
见 [docs/sandbox-api.md](docs/sandbox-api.md)。

命令在 Docker 沙盒里跑（`/usr/local/bin/rb`）。

## 文档

- [docs/OPERATIONS.md](docs/OPERATIONS.md) —— 运维命令全表、故障排查
- [docs/NOTES.md](docs/NOTES.md) —— 踩过的坑和当时的判断
- [DEPLOY.local.md](DEPLOY.local.md) —— 这台机器上的部署事实（端口、路径、容器参数、自启）
