# Agent 与开发者多环境部署指南

面向在本机拉起 rabbit-bot、排查环境问题、或接手部署的 Agent / 开发者。覆盖 macOS、Linux（原生）和 Windows + WSL2。

> 边界：容器内沙盒根始终是 `/work`，工具名/参数、提示词占位符、任务文档验收口径和 REST API 返回结构都不随宿主平台变化。本指南只讲宿主侧怎么装、怎么跑、怎么排错。

## 0. 支持矩阵

| 宿主 | 支持级别 | 推荐形态 |
|---|---|---|
| macOS | 完整支持（当前生产基线） | 原生 + Docker Desktop / Colima |
| Linux x64 | 支持，需装系统依赖 | 原生 + Docker Engine |
| Windows + WSL2 | 推荐落地方式 | 后端、pm2、worker 全放 WSL2；Docker Desktop 用 WSL2 backend |
| Windows 原生 | 不作为支持目标 | 能跑一部分，但 host 模式被禁用，脚本/进程语义不完整 |

判断当前平台：

```bash
node -p "process.platform"
uname -a          # macOS / Linux / WSL2
docker info --format '{{.OSType}}'   # 必须是 linux
```

WSL2 内 `process.platform` 是 `linux`，`/bin/ps`、`bash`、`pgrep`、`lsof` 都可用，因此后端代码走 Linux 分支。

## 1. 路径与目录约定

| 内容 | 默认位置 |
|---|---|
| 源码 | 仓库根（本机示例 `~/projects/rabbit-bot`） |
| 应用根 | `<repo>/app` |
| 运行时目录 | `~/.config/rabbit-bot/runtime`（可用 `RABBIT_BOT_RUNTIME` 覆盖） |
| 凭据 / env | `~/.config/rabbit-bot/env`（可用 `RABBIT_BOT_ENV_FILE` 覆盖） |
| 数据 | `<app>/data/rabbit-bot.db` |
| 任务文档 | `<runtimeDir>/.ufa/tasks/task-<id>.md` |
| 执行器日志 | `<app>/data/tasks/<id>/runner.jsonl` |
| 日志 | `<app>/logs/` |

- 运行时目录默认同时就是沙盒根：宿主看到 `~/.config/rabbit-bot/runtime/xxx`，容器里看到 `/work/xxx`。
- `exec.dir` 留空表示跟随运行时目录；只有显式配置时才需要另挂载。
- 凭据只放仓库外，不要写进 `config/*.json`，不要提交。

## 2. 系统依赖

通用要求：

- Node.js ≥ 22.19（`package.json` 的 `engines`），npm ≥ 10
- Git
- 使用 Docker 沙盒时：Docker 20.10+（`--add-host host.docker.internal:host-gateway` 需要）
- 图片压缩依赖 macOS 的 `sips`；Linux / Windows 上图片会降级保存为 `.bin`，消息仍能入池，但模型看不到图

Linux（Debian / Ubuntu）建议补：

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 make g++ bash coreutils procps lsof
# 可选：图片压缩替代
sudo apt-get install -y imagemagick
```

macOS：

```bash
xcode-select --install      # better-sqlite3 原生模块可能需要
```

WSL2：

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 make g++ bash coreutils procps lsof
```

`better-sqlite3` 是原生模块。npm 11 默认不跑 install scripts，装上但加载失败时：

```bash
cd app
npm install --no-audit --no-fund
npm rebuild better-sqlite3 esbuild protobufjs fsevents
node -e "require('better-sqlite3')(':memory:').exec('create table t(a)')"
```

`npm install-scripts` 不是 npm 自带的命令；旧文档里的 `npm install-scripts approve ...` 已失效，统一用上面的 `npm rebuild`。

## 3. Docker 沙盒设置

### 3.1 必须用 Linux 容器

沙盒参数依赖 Linux 语义：`--read-only`、`--tmpfs`、`--cap-drop ALL`、`--pids-limit`、`no-new-privileges`。Docker Desktop 切到 Windows 容器模式会直接失败。

```bash
docker info --format '{{.OSType}}'   # 期望输出 linux
```

WSL2 还要在 Docker Desktop 里：

1. Settings → General → 勾选 **Use the WSL 2 based engine**
2. Settings → Resources → WSL Integration → 给目标发行版打开集成
3. 进入该发行版执行 `docker info`，确认能连上 daemon

### 3.2 构建沙盒镜像

```bash
cd app
docker build -t rabbit-bot-sandbox:latest -f docker/sandbox.Dockerfile docker/
```

可选：需要 python/git/curl/jq/rg 的扩展镜像按 `docker/sandbox.Dockerfile` 自行派生。

### 3.3 挂载与 uid

- 容器只挂运行时目录（以及 `prompt/`、`topics/`、外部技能库等叠加子路径），宿主其余路径在容器内不存在。
- 挂载用 `--mount type=bind,source=<宿主绝对路径>,target=/work[,readonly]`，不再拼 `-v host:container:mode`。
- 容器 label `rabbit-bot.sandbox-mounts=<hash>` 记录期望挂载。是否重建容器只看 label + `Destination` + `RW`，不比较 Docker 返回的 `Source` 原始字符串，避免 Docker Desktop / WSL 下 Source 漂移导致每条 terminal 都重建容器。升级到带 label 的版本后，旧容器会因缺少 label 重建一次，属正常。
- POSIX 下容器用户取宿主真实 uid/gid；Windows 原生不传 `--user`。WSL2 建议运行时目录放 WSL 的 ext4 家目录，不要放 `/mnt/c`。
- 代码不挂 Docker socket，容器不能控制宿主 daemon；Windows 不需要处理命名管道。

### 3.4 网络

`exec.shell.network` 默认 `bridge`；`none` 完全断网。容器通过 `host.docker.internal:host-gateway` 访问宿主 API。

## 4. 安装与启动

### 4.1 macOS / Linux（原生）

```bash
cd <repo>/app
npm install --no-audit --no-fund
npm run build

mkdir -p ~/.config/rabbit-bot
cat > ~/.config/rabbit-bot/env <<'EOF'
DEEPSEEK_API_KEY=...
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
# 启用 Matrix 时再填：MATRIX_TOKEN=...
# 至少 16 位；太短时本地注入口不启动
RABBIT_BOT_INJECT_TOKEN=...
EOF
chmod 600 ~/.config/rabbit-bot/env

docker build -t rabbit-bot-sandbox:latest -f docker/sandbox.Dockerfile docker/
npm install -g pm2          # 没装过 pm2 才需要
pm2 start ecosystem.config.cjs
pm2 save
npm run doctor
```

`pm2 start` 是唯一启动入口，不要再手工 `run.sh`，否则两个实例会抢消息。单实例锁会以退出码 3 拒绝第二个实例。

不接飞书 / Matrix、只用网页直聊时，把 `adapters.feishu.enabled` 和 `adapters.matrix.enabled` 设为 `false`，保留 `webChat.enabled: true`；`run.sh` 预检同样放行。这条路径适合本机试用。

### 4.2 Windows + WSL2

1. 安装 WSL2 发行版（Ubuntu 即可）和 Docker Desktop。
2. 在 WSL2 内完成 4.1 的全部步骤；源码和运行时目录都放 WSL 家目录（如 `~/projects/rabbit-bot`、`~/.config/rabbit-bot`），不要放 `/mnt/c/...`。
3. worker（opencode / mimo / codex / claude）也装在 WSL2 内，`RB_APP_DIR`、任务 `work_dir` 都用 WSL 路径。
4. 从 Windows 侧访问管理台：WSL2 的 `localhost` 会转发到 Windows，直接打开 `http://localhost:3738`。
5. PM2 开机自启：在 WSL2 内用 systemd 或登录脚本执行 `pm2 resurrect`；不要用 Windows 计划任务直接拉起 WSL 里的 pm2。

验证：

```bash
docker info --format '{{.OSType}}'    # linux
node -p "process.platform"           # linux
docker inspect -f '{{index .Config.Labels "rabbit-bot.sandbox-mounts"}}' rabbit-bot-sbx
```

### 4.3 Windows 原生（仅了解，不推荐）

- `exec.shell.mode=host` 在配置校验阶段直接报错，必须用 `docker` 模式。
- npm 安装的 `opencode` / `mimo` / `codex` / `claude` 可能是 `.cmd` 垫片；启动时会用 `where` 解析并交给 shell，停止任务用 `taskkill /PID <pid> /T`。
- `package.json` 的 `postinstall`、`doctor`、`inject`、`sbx` 仍是 `bash` 脚本，原生 Windows 需要 Git Bash 或改走 WSL2。
- 任务文档在 win32 上会额外附 PowerShell 版 `Invoke-RestMethod` 示例，但只建议作为兜底。

## 5. 验证清单

```bash
cd app
npm run typecheck
npm test
npm run build
npm run web:typecheck
npm run web:build       # 前端有改动时必须
npm run doctor
```

运行时冒烟：

```bash
curl -s http://127.0.0.1:3738/health
npm run sbx -- status
```

在 Agent 的 `terminal` 里：

```bash
pwd                    # 期望 /work
ls -la /work
echo ok > /work/probe.txt && cat /work/probe.txt
```

任务链路：

1. 建一个任务，确认管理台看到执行器启动。
2. `stopTask` 后 `ps aux | grep -E 'opencode|mimo|codex|claude'` 无孤儿。
3. `pm2 restart rabbit-bot` 后确认运行中的任务被接回（任务事件里有「已接回执行器进程」）。

## 6. 平台适配实现位置

| 能力 | 位置 |
|---|---|
| 换行符统一 LF | 仓库根 `.gitattributes` |
| `~` 展开、env 文件位置、路径包含判断 | `app/src/core/platform.ts` |
| 可执行文件解析、`.cmd` spawn、进程树信号 | `app/src/core/platform.ts`（`resolveExecutable` / `spawnPlan` / `killTree`） |
| Docker 挂载、挂载指纹、uid/gid | `app/src/core/shell-runner.ts`（`mountFingerprint` / `sandboxMountArgs` / `sandboxUserArgs`） |
| 单实例锁身份 | `app/src/core/lockfile.ts`（POSIX `ps`，Windows PowerShell） |
| host 模式平台限制 | `app/src/config.ts` 校验 + `shell-runner.ts` 运行时防御 |
| 任务文档平台分支 | `app/src/core/dispatch.ts`（win32 追加 PowerShell 示例） |

## 7. 常见踩坑

### CRLF 导致脚本起不来

现象：`bad interpreter: /usr/bin/env bash^M`。仓库已加 `.gitattributes`；旧克隆重新检出：

```bash
git rm --cached -r .
git reset --hard
```

或临时 `git config core.autocrlf input` 后重新 checkout。

### WSL2 把项目放 `/mnt/c`

现象：npm install / git / docker 很慢，挂载权限异常，容器写 `/work` 失败。把源码和运行时目录放 WSL 家目录（ext4）。

### 每条 terminal 都很慢或命令被杀

旧实现按 `docker inspect .Mounts[].Source` 精确比较，Docker Desktop / WSL 下 Source 形式不同会触发反复重建容器。现在用 `rabbit-bot.sandbox-mounts` label + `Destination` + `RW` 判断。若仍频繁重建，检查：

```bash
docker inspect -f '{{json .Mounts}}' rabbit-bot-sbx
docker inspect -f '{{index .Config.Labels "rabbit-bot.sandbox-mounts"}}' rabbit-bot-sbx
```

### 容器里 `/work` 不可写

确认运行时目录在当前用户可写；POSIX 下容器用宿主 uid/gid。WSL2 不要挂 `/mnt/c`。

### 图片变成 `.bin`

`media.ts` 优先用 macOS `sips`。非 macOS 上会回退为 `.bin` + `application/octet-stream`，上层跳过喂图。需要图片能力时装 ImageMagick 并扩展 `media.ts`，或在 macOS 上处理。

### 执行器显示未安装

管理台探测顺序：`opencode`、`MIMO_BIN`、`CODEX_BIN`、`CLAUDE_BIN`。执行器不在 PATH 时：

```bash
export MIMO_BIN=/path/to/mimo
export CODEX_BIN=/path/to/codex
export CLAUDE_BIN=/path/to/claude
```

Windows 原生会解析 `.cmd` / `.exe`；WSL2 内按 Linux 路径解析。

### `pm2 restart` 后改动没生效

`pm2 restart` 不编译。后端改 `src/**` 必须先 `npm run build`；前端改 `webapp/src/**` 必须先 `npm run web:build`。只改 `config/prompt/*.md` 或 `persona.md` 才只需要 restart。

### 启动报「已有实例在跑」

单实例锁在 `data/run/main.pid`。先确认没有旧进程：

```bash
ps -o pid,lstart,command -p "$(node -e "const fs=require('fs');try{console.log(JSON.parse(fs.readFileSync('data/run/main.pid','utf8')).pid)}catch{}")"
```

只有确认进程已死才删锁；pid 复用会被启动时间校验识别。

### 停止任务后还有孤儿进程

POSIX 下执行器是独立进程组，`stopTask` 杀整组；Windows 原生用 `taskkill /PID /T`。若仍有残留，用 `ps -o pid,ppid,pgid,command` 检查是否被其他 supervisor 拉起。

## 8. 升级与回滚

```bash
git pull --ff-only
cd app
npm install --no-audit --no-fund
npm run build
npm run web:build       # 前端有改动时
pm2 restart rabbit-bot
```

- 只回滚代码：`git checkout <commit> -- app/src app/webapp` 后重新 build。
- 回滚数据：SQLite 在 `app/data/rabbit-bot.db`，先停服务再替换；WAL 文件一并处理。
- 回滚沙盒：`docker rm -f rabbit-bot-sbx`，下次 terminal 会按当前配置重建。

## 9. 相关文档

- `skills/rabbit-bot/deploy/SKILL.md`：Agent 闭环部署主流程（分层、一句话复制指令、确定性排障决策树）
- `app/DEPLOY.local.md`：本机历史部署事实与运维经验
- `app/README.md`：部署、Web 管理台、任务执行模型
- `app/docs/OPERATIONS.md`：日常命令
- `app/docs/NOTES.md`：实现笔记
- `docs/TROUBLESHOOT-executor-and-approval.md`：执行器与审批排障
