# rabbit-bot

一个跑在飞书、Matrix 等 IM 上的聊天 Agent。**池子就是上下文**——它没有会话记忆，每一轮都从池子里读最近的对话和记忆文件，然后决定说不说、说什么。

设计原则：调度、去重、游标、预算这些**全是确定性代码**；模型只负责一件事——说话。

## 快速开始

```bash
npm install
npm run build

mkdir -p ~/.config/rabbit-bot && cat > ~/.config/rabbit-bot/env <<'EOF'
DEEPSEEK_API_KEY=...
# 至少启用一个真实适配器：飞书用 FEISHU_*，Matrix 用 MATRIX_TOKEN
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
# 启用 Matrix 时再填：
# MATRIX_TOKEN=...
RABBIT_BOT_INJECT_TOKEN=$(openssl rand -hex 24)   # 本地注入口用，必须设
EOF
chmod 600 ~/.config/rabbit-bot/env

pm2 start ecosystem.config.cjs     # 用 pm2，别同时手工 run.sh（会起两个进程抢消息）
npm run doctor                     # 体检：进程 / 锁 / 注入口 / 沙盒 / 唤醒分布
```

适配器在 `config/default.json` / `config/local.json` 的 `adapters.feishu.enabled`、`adapters.matrix.enabled` 里开关（默认飞书开、Matrix 关），至少启用一个真实适配器。
飞书启用但缺 `FEISHU_*`、或 Matrix 启用但缺 `MATRIX_TOKEN`，都会 `exit 2` 不启动（`run.sh` 预检）；已经有实例在跑会 `exit 3`。

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
| `runtime/shared/` | worker 交上来的汇报（`task-<id>.md`），`read_file` 直接读 | 不用 |
| `runtime/files/` | 收到的非图片附件 | 不用 |

规则只有一条：**运行时目录有就用它，没有才用仓库里的默认份。** 没有配置开关。仓库里的
`config/persona.example.md` 和 `prompts/` 是模板和默认提示词，clone 下来能直接跑。

运行时目录同时就是沙盒根：容器里 `/work` 就是它，所以 `prompt/`、`topics/`、`skills/`、
`shared/`、`files/` 在容器和宿主看到的是同一份。`shared/` 是 worker 交汇报的固定落点
（`/work/shared/task-<id>.md`）。挂载源变了进程启动时会重建容器。

## 怎么和它说话

| 方式 | 命令 |
|---|---|
| 飞书私聊 / 群里 @ | 直接发 |
| Matrix 私聊 / 群里 @ | 直接发（私聊按房间成员数 ≤2 判定） |
| 本地注入（绕过 IM） | `npm run inject -- "在吗"` |
| 浏览器管理台 | 打开 `http://127.0.0.1:3738/`（端口见 `config.api.port`） |

## Web 管理台

正式服务启动后，同一个端口也提供本地网页管理台：打开 `http://127.0.0.1:3738/`，
输入 API token 即可。token 默认在 `app/data/run/api.token`，也可以用环境变量
`RABBIT_BOT_API_TOKEN`（≥16 位）。页面本身不需要登录就能打开，但所有数据接口都要
Bearer token，token 不对会明确提示。

**聊天收发走已启用的 IM（飞书 / Matrix）；任务审批在任务发起的 IM 聊天或固定审批房完成。Web 是可选的本地管理台，负责人格、提示词、记忆和只读面板。**

能做的事：

- 会话：看池列表（alias / 标题 / 私聊群聊 / 最后消息时间 / 总数），看消息时间线并区分机器人自己发的；每 3 秒轮询，支持向上翻页。
- 任务：按 status 过滤，展开看 deliverable / constraints / acceptance / result / artifact / note 和 worker 快照；`pending_approval` 的任务可在这里改描述后通过并执行 / 驳回。开启 `taskApproval` 后，任务提示会发到任务发起的聊天（或固定的 IM 审批房），主人贴 OK 就直接启动，Web 只是可选的备用入口。
- 权限：按 status 过滤查看权限申请；**这是运行时权限申请，审批请在已启用的 IM（飞书 / Matrix）里完成，此页只展示**。
- Worker：只读查看 worker_id / name / kind / status / last_seen_at。
- 计划：只读查看待办列表。
- 记忆：按当前池和用户查看，可直接改正文或删除（新增/过期仍走 IM）。
- 人格：可直接编辑人设和系统提示词，保存到运行时目录；下一轮换新会话生效。
- 调度：私聊唤醒间隔、群聊 tick 周期、任务群 tick 周期三个值（按秒展示）；保存后立即生效，并写入 `<dataDir>/run/scheduler.json`，重启后仍保留。被 @ 的消息仍走快速去抖。任务事件按任务群周期 batch 进下一次 tick，不对每条进度单独唤醒。
- 技能：只读列表（名字、描述、SKILL.md / data 路径）。
- 顶栏显示 API 健康状态和当前连接地址；移动端可用。

前端在 `app/web/`，原生 HTML/CSS/JS，没有构建链，也不引用任何 CDN、外部字体或图片。

### demo 模式（只看现有库）

```bash
npm run web                 # 默认 127.0.0.1:3738，读 data/rabbit-bot.db
npm run web -- --port 3748  # 正式服务占着 3738 时换端口
npm run web -- --host 0.0.0.0
```

demo 模式不连任何真实 IM、不需要 LLM 凭据，提供只读会话/任务面板和人格、提示词、记忆管理。
它没有入池能力，也不会生成回复；聊天收发走已启用的 IM（飞书 / Matrix），任务审批默认在任务发起时的 IM 聊天/审批房完成，Web「任务」页是可选的备用入口。

## 真实 worker 与 e2e

当前推荐的任务执行模型是**每个任务一个一次性进程**（不常驻 worker）：建任务时给
`work_dir`，系统写 `.ufa/tasks/task-<id>.md` 并启动 `opencode` / `mimo`，恢复时用
同一个 session id。契约见 `../docs/WA-WORKER-API.md`。

下面这段 `scripts/wa-worker.ts` 是旧的常驻轮询实现，**仅保留兼容**，新任务不要再用它。

```bash
# demo：不调 LLM，睡 3 秒后把当前时间写成 result
npx tsx scripts/wa-worker.ts \
  --api http://127.0.0.1:3738 --token "$(<data/run/api.token)" \
  --worker-id wa-local --poll-ms 2000 --mode demo --dir "$PWD"

# opencode：把 goal/deliverable/constraints/acceptance 拼成提示词，
# 调 `opencode run "<prompt>" --dir <dir> --format json`，拼接所有 text 事件作为 result
npx tsx scripts/wa-worker.ts \
  --api http://127.0.0.1:3738 --token "$(<data/run/api.token)" \
  --worker-id wa-opencode --poll-ms 2000 --mode opencode --dir /abs/project

# mimo：本机安装的 mimo（非 TTY 下别跨出 --dir 根目录，否则会被 external_directory 拒绝）
npx tsx scripts/wa-worker.ts \
  --api http://127.0.0.1:3738 --token "$(<data/run/api.token)" \
  --worker-id mimo --poll-ms 2000 --mode mimo \
  --mimo-bin /Users/viking/.mimocode/bin/mimo --dir /abs/project
```

- `--mode demo`：不发网络请求给模型，适合验证注册/领任务/快照/回传链路。
- `--mode opencode`：真跑 `opencode`，跑多久就多久；worker 每 30s touch 续租。
- `--mode mimo`：真跑本机 `mimo`，命令是
  `mimo run "<prompt>" --dir <dir> --title "WA-task-<id>" --format json`。默认
  执行器 `/Users/viking/.mimocode/bin/mimo`，可用 `--mimo-bin` 换。
- 两种真跑模式都支持 `--model`：opencode 传 `-m <model>`，mimo 传 `--model <model>`。
- `--timeout-ms`（默认 600000）超时会杀掉子进程并按失败回传。
- `--mimo-extra <arg>` 可重复追加 mimo 参数（原样透传，不会默认加 `--yolo`）。
  mimo 在非 TTY 下如果访问 `--dir` 根目录之外会被 `external_directory` 拒绝；
  工作目录保持在 `--dir` 内就不需要额外参数。
- 权限模拟：启动时加 `WA_DEMO_APPROVAL=1`。worker 会在干活前 `POST /v1/approvals`
  申请一条（action 写明任务号），每 2s 查一次；`approved` 继续，`rejected` /
  `timeout` / 到 `expires_at` 都按失败回传。
- `SIGINT` / `SIGTERM` 只停止领新任务，不删任何数据；当前任务会做完再退出。

端到端测试（真 API + 真 worker 进程 + 临时库 `app/.scratch/e2e-wa.db`）：

```bash
npx tsx scripts/e2e-wa.ts
```

三个场景：A 正常完成、B 权限申请后批准、C 连续完成 3 个任务只置一条
`ufa.pending_task_tick`。每个场景打印 `PASS`/`FAIL`，失败退出码非 0。
测试结束会关服务器和 worker 进程，不会碰 `data/rabbit-bot.db`。

## 目录

```
src/core/        调度器、消息池、计划、循环守卫、读图、沙盒文件区、容器沙盒
src/agent/       pi 会话封装（engine）、工具定义（tools）、提示词（prompt）
src/adapters/    飞书 / Matrix / mock（sim 与测试用）
src/ctl.ts       运维命令（pause / resume / status / usage / wakes / plans …）
scripts/         run.sh（pm2 的前台入口：读 env → 预检 → exec node）、doctor.sh（体检）、inject.sh（注入）、sbx.sh（沙盒容器）
docker/          沙盒镜像 Dockerfile
test/            480+ 条，node --test
data/            运行时数据（db / media / 会话），.gitignore
prompts/         默认提示词模板（真身在运行时目录）
```

## 工具清单（模型能调的 10 个）

| 工具 | 干什么 |
|---|---|
| `chat` | `send` 发消息（唯一对外出口）/ `skip` 这轮不回 / `view` 读图进上下文 / `list` 有哪些池 / `search` 翻原话 |
| `memory` | `recent` / `search` / `add` / `expire`（不再成立，关掉）/ `update`（就地订正）/ `help` |
| `plan` | `add` / `done` / `list` / `help` |
| `approval` | 查看和裁决 worker 的权限申请：`list` / `get` / `decide`（approved / rejected）/ `help` |
| `task` | 任务面板：`create`（建任务，pending_approval 等审批）/ `list` / `get` / `updates` / `resume` / `note` / `cancel` / `status` / `help` |
| `worker` | `list` 看已注册的 worker（id / 名字 / kind / 状态 / 最近心跳）/ `help` |
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
