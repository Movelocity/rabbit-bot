---
name: deploy
description: rabbit-bot 第一次部署、换机器重装、升级、启动失败、pm2 起不来、不接 IM 只想网页直聊、接飞书时读。按「演示 → 本机闭环 → 飞书 → 生产常驻」分层，每步有命令、期望输出、失败分支和确定性排障决策树，供 Agent 闭环执行。
---

# rabbit-bot 部署（Agent 闭环版）

这份技能是部署的唯一主流程。目标不是「把命令列出来」，而是让 Agent 能自己走到可验证的完成态：每一步都有前置、命令、期望输出和失败分支；失败按 `references/troubleshooting.md` 的决策树走；不能验证就报 blocked，不报完成。

## 一句话复制指令

把 `<repo>` 换成仓库绝对路径（技能已安装时可换成 `~/.agents/skill-library/rabbit-bot/deploy/SKILL.md`），整句粘给 opencode / workbuddy：

```text
读 <repo>/skills/rabbit-bot/deploy/SKILL.md，按里面的 Agent 闭环部署流程执行；从目标层开始，每步跑完对照期望输出，失败按 references/troubleshooting.md 决策树处理，最后用「交付判定」逐项给出 PASS/FAIL，不要跳过验证。
```

opencode 也可以直接：

```bash
opencode run "读 <repo>/skills/rabbit-bot/deploy/SKILL.md，按里面的 Agent 闭环部署流程执行；从目标层开始，每步跑完对照期望输出，失败按 references/troubleshooting.md 决策树处理，最后用「交付判定」逐项给出 PASS/FAIL，不要跳过验证。"
```

## 执行契约（先读，违反就算失败）

1. **一次只推进一层。** 第 0 层过了再进第 1 层；第 1 层过了再进第 2 层。不要跳层，也不要把飞书和生产常驻混在一步里。
2. **每步都要有证据。** 跑命令、贴关键输出（不要贴密钥）、对照期望。只看文件存在不算通过。
3. **未验证不报完成。** 缺 API Key、缺飞书应用、缺 Docker 时，按「人工卡点」停下并明确要什么；不要猜。
4. **密钥只在 `~/.config/rabbit-bot/env`（权限 600）。** 不写进仓库、`config/*.json`、日志、任务文档或本技能。
5. **同一时间只允许一个 rabbit-bot 进程。** 不要同时用 pm2 和手工 `run.sh`。
6. **人工步骤单独标出。** 飞书建应用、发布、首次私聊、提供 LLM Key、设置 Web 密码，Agent 代做不了，必须停下来要。
7. **只改仓库内和被明确允许的运行时目录。** 不顺手重构、不扩大范围。

## 0. 选层（确定性判断）

| 用户想要 | 走哪层 | 前置 | 完成标准 | Agent 能否独立闭环 |
|---|---|---|---|---|
| 先看看它是什么样 | L0 演示 | Node ≥ 22.19、git | `npm run demo` 退出码 0 | 能 |
| 本机能用、没有 IM 账号 | L1-Web | L0 + LLM Key | 网页直聊发消息能收到回复 | 能（Key 需人给） |
| 接飞书聊天 | L1-Feishu | L1-Web + 飞书管理员权限 | 飞书私聊收到回复 | 建应用/发布需人做 |
| 长期在线、公网可用 | L2 生产 | L1 + Docker + pm2 | 重启/开机自恢复、有隔离和备份 | 大部分能，公网暴露需人确认 |

判断规则：

- 用户没指定：先 L0，再 L1-Web。**不要默认去接飞书或开公网。**
- 用户说「不接飞书 / 只想网页聊」：只做 L1-Web。
- 用户说「接飞书」：先做 L1-Web 打通本机链路，再做 L1-Feishu；本机链路能显著缩小飞书排障范围。
- 用户说「上线 / 长期跑 / 给别人用」：L1 全过再做 L2。

## 1. 通用前置（所有层）

在仓库根执行：

```bash
node -v && npm -v
uname -s
cd <repo>/app && pwd
```

期望：

- Node `v22.19.0` 或更高；npm `10` 或更高。
- 平台是 `Darwin` 或 `Linux`。`MINGW*` / `MSYS*`（Windows 原生）不支持，改用 WSL2。
- 当前目录是 `<repo>/app`。

跑确定性检查脚本（只读，不会启动服务）：

```bash
bash <技能目录>/scripts/deploy-check.sh --layer auto
```

技能装在 `~/.agents/skill-library/rabbit-bot` 时脚本找不到仓库，需加 `--app <repo>/app` 或设置 `RB_APP_DIR=<repo>/app`。

如果是全新的干净机器，先跑 L0 的 `npm install`，再回来跑本检查；否则 `deps` 一项会 FAIL，这是预期。

期望：没有 `FAIL` 行；`WARN` 行能解释。脚本行格式：`PASS|WARN|FAIL<TAB>检查项<TAB>说明`。

失败：直接跳到 `references/troubleshooting.md` 的 `D0`。

## 2. L0：演示（不接 IM、不配 Key、不装 Docker）

```bash
cd <repo>/app
npm install --no-audit --no-fund
npm run demo
```

期望：

- 退出码 0。
- 终端出现 5 段演示：私聊去抖、群聊 tick / @、计划看板、防死循环、暂停开关。
- 末尾有 `汇总` 和 `用量`；没有 `Error` / `Cannot find module`。

失败分支：

| 现象 | 处理 |
|---|---|
| `better-sqlite3` 加载失败 | `npm rebuild better-sqlite3`，再跑 `node -e "require('better-sqlite3')(':memory:').exec('create table t(a)')"`。不要用 `npm install-scripts`，npm 没这个命令。 |
| Node 版本过低 | 升到 ≥ 22.19；nvm / fnm 切换后重开终端。 |
| 安装脚本被跳过导致 esbuild 不可用 | `npm rebuild esbuild`，再重跑。 |
| `npm install` 网络失败 | 换镜像或重试；不要跳过依赖直接跑。 |

L0 通过后再进 L1。

## 3. L1-Web：本机闭环（推荐先做，Agent 可独立验收）

这条路径不建任何 IM 长连接：网页直聊是独立出口，消息入 `web:web-chat` 池，回复写回同一个池。

### 3.1 人工卡点：LLM Key

需要所选 provider 的 API key。默认 `config/default.json` 是 `deepseek` / `deepseek-flash`，对应 `DEEPSEEK_API_KEY`。

如果当前环境没有 key，停下并只问这一句：

```text
请把 DeepSeek API Key 放到 ~/.config/rabbit-bot/env 的 DEEPSEEK_API_KEY=（或告诉我改用哪个 provider），我再继续。
```

不要用假 key，不要把 key 贴进聊天记录或仓库。

### 3.2 写环境变量

```bash
mkdir -p ~/.config/rabbit-bot
# 已有 env 就追加/替换，不要整文件覆盖别人的凭据
grep -q '^DEEPSEEK_API_KEY=' ~/.config/rabbit-bot/env 2>/dev/null || \
  printf 'DEEPSEEK_API_KEY=<你的 key>\n' >> ~/.config/rabbit-bot/env
grep -q '^RABBIT_BOT_INJECT_TOKEN=' ~/.config/rabbit-bot/env 2>/dev/null || \
  printf 'RABBIT_BOT_INJECT_TOKEN=%s\n' "$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')" >> ~/.config/rabbit-bot/env
chmod 600 ~/.config/rabbit-bot/env
```

期望：`stat -f '%Lp' ~/.config/rabbit-bot/env`（macOS）或 `stat -c '%a'`（Linux）输出 `600`；`RABBIT_BOT_INJECT_TOKEN` 至少 16 位。

### 3.3 写本机配置

编辑 `<repo>/app/config/local.json`，**保留已有键**，只合并下面几项：

```json
{
  "adapters": {
    "feishu": { "enabled": false },
    "matrix": { "enabled": false }
  },
  "webChat": { "enabled": true },
  "exec": { "shell": { "mode": "host" } },
  "api": { "host": "127.0.0.1" }
}
```

- `exec.shell.mode=host` 只用于本机试用：命令直接跑在宿主机，没有隔离。生产必须切 `docker`（见 L2）。
- `api.host=127.0.0.1` 只让本机访问；要局域网访问再改，且先设 Web 密码。
- 旧配置里如果写的是 `sandbox`，程序会自动搬到 `exec` 并 warn；新写一律用 `exec`。
- 如果这台机器已经有可用的飞书配置，**不要为了网页直聊把 feishu 关掉**；只补 `webChat`、`exec`、`api` 三项，保留已有适配器。

期望：`cd <repo>/app && npx tsx -e 'import { loadConfig } from "./src/config.ts"; const c=loadConfig({}); console.log(c.exec.shell.mode, c.adapters.feishu.enabled, c.webChat?.enabled)'` 输出 `host false true`。

### 3.4 装依赖、构建、启动

```bash
cd <repo>/app
npm install --no-audit --no-fund
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

如果 `pm2` 不存在：

```bash
npm install -g pm2
```

权限不足时不要强行 sudo 改全局环境；改用当前用户可写的 npm prefix，或先只做临时前台验证并把它标为未常驻。

期望：`pm2 list` 里 `rabbit-bot` 是 `online`，不是 `errored` / `stopped`。

### 3.5 验证（四项全过才算 L1-Web 完成）

```bash
# 1) 健康检查
curl -s http://127.0.0.1:3738/health

# 2) 体检：进程数 1、锁活着、API 在听、沙盒模式能读出来
cd <repo>/app && npm run doctor

# 3) 确定性检查
bash <技能目录>/scripts/deploy-check.sh --layer web

# 4) 网页直聊往返：发一句，等自回复
bash <技能目录>/scripts/deploy-check.sh --layer web --roundtrip
```

期望：

- `/health` 返回 `{"ok":true,"data":{"status":"ok","exec":"host",...}}`。
- `doctor` 不再出现 `mode: 读取失败`；`跑着 dist/main.js 的进程：1`；API 端口在听。
- `deploy-check.sh` 没有 `FAIL`。
- `--roundtrip` 显示 `PASS webchat_roundtrip` 并打印回复摘要；默认最多等 120 秒。

`--roundtrip` 会真实调用一次 LLM，产生少量费用。

失败：跳到 `references/troubleshooting.md` 的 `D1`，按决策树走，不要盲重启。

### 3.6 人工验收（可选但推荐）

浏览器打开 `http://127.0.0.1:3738/`，首次使用会引导设置密码（至少 6 位）。Agent 不要替用户设密码，也不要把它写进任何文件。

## 4. L1-Feishu：接飞书（有 LLM/建应用人工卡点）

先在 L1-Web 验证本机链路正常，再按 `references/feishu-setup.md` 让人完成应用创建、权限、事件、发布和可用范围。

人工步骤完成后，Agent 做：

1. 把 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 写进 `~/.config/rabbit-bot/env`（600，不打印）。
2. `config/local.json` 改 `adapters.feishu.enabled: true`，保留 `webChat.enabled: true` 作为备用出口。
3. `npm run build && pm2 restart rabbit-bot`。
4. 检查日志：`pm2 logs rabbit-bot --lines 100` 里应出现飞书长连接建立，且没有 `缺少环境变量` / `open_id cross app`。
5. 让用户在飞书私聊里发第一条消息。池由入站消息建立；**没有入站消息就不能主动发**。
6. 验证回复：

```bash
cd <repo>/app
TOKEN="${RABBIT_BOT_API_TOKEN:-$(cat data/run/api.token)}"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3738/v1/pools
```

期望：能看到 `platform: feishu` 的池，并且最近消息里有用户刚发的那条和机器人回复。只看到用户消息、没有自回复 → `troubleshooting.md` 的 `D7`。

### 飞书硬约束

- 必须是独立自建应用，不能复用别的服务（同一 app 两条长连接会互相抢消息，且都不报错）。
- 事件走长连接，权限和事件清单见 `references/feishu-setup.md`。
- 应用要发布并放到可用范围，未发布时事件不会到。
- 首条消息必须由人发出。

## 5. L2：生产常驻（Docker + pm2 + 备份）

L1 全过后再做，细节见 `references/production.md`。主顺序不能变：

1. `docker info --format '{{.OSType}}'` 必须是 `linux`。
2. 构建沙盒镜像：`docker build -t rabbit-bot-sandbox:latest -f docker/sandbox.Dockerfile docker/`。
3. 把 `exec.shell.mode` 从 `host` 切回 `docker`，重启。
4. **先收紧入口再开放端口**：设置 `webChat.password`（或 `RABBIT_BOT_WEB_PASSWORD`），只绑回环，反代到公网；不要把 3738 裸奔。
5. pm2 开机自启：macOS launchd / Linux systemd / WSL2 登录脚本；改过进程列表必须 `pm2 save`。
6. 备份 SQLite（含 WAL）、runtime、env；演练一次升级和回滚。

生产验收：

```bash
cd <repo>/app
npm run doctor
npm run sbx -- status
bash <技能目录>/scripts/deploy-check.sh --layer production
```

期望：`exec` 是 `docker`，容器 `rabbit-bot-sbx` 在跑，`/work` 可写，进程数 1，`deploy-check` 无 `FAIL`。

## 6. 交付判定（逐项给 PASS / FAIL）

- [ ] 选定的层和目标说清楚（L0 / L1-Web / L1-Feishu / L2）
- [ ] `npm run demo` 退出码 0（仅 L0 需要）
- [ ] `/health` 返回 `status: ok`
- [ ] `npm run doctor` 无 `mode: 读取失败`，进程数为 1
- [ ] `deploy-check.sh` 对应层无 `FAIL`
- [ ] 网页直聊 `--roundtrip` 收到自回复（L1-Web 必做）
- [ ] 飞书私聊收到回复（L1-Feishu 必做）
- [ ] `env` 权限 600；仓库里没有密钥
- [ ] 公网入口已设密码且不在裸奔（L2）
- [ ] 备份、升级、回滚至少演练过一次（L2）
- [ ] 失败项写明现象、已试过什么、还缺什么、下一步谁做

## 7. 回传格式

```text
部署层：L2 生产
结果：PASS / FAIL / BLOCKED
证据：/health=ok；doctor 进程=1、exec=docker；deploy-check 0 FAIL；roundtrip 收到回复
阻塞：无 / 缺 DEEPSEEK_API_KEY / 等飞书应用发布
改动：config/local.json（exec docker、api 127.0.0.1）、env（未打印）
回滚：pm2 restart rabbit-bot；git checkout <commit> -- app/src app/webapp && npm run build
```

## 8. 相关文档

- `references/troubleshooting.md`：确定性排障决策树（D0–D11），先查这里再改代码。
- `references/feishu-setup.md`：飞书建应用、权限、事件、发布、首条消息。
- `references/production.md`：Docker、pm2 自启、备份、升级回滚、安全。
- `app/README.md`：部署、Web 管理台、网页直聊、任务模型。
- `docs/agent-environment.md`：macOS / Linux / WSL2 系统依赖与平台差异。
- `app/docs/OPERATIONS.md`：日常命令与故障速查。
- `app/DEPLOY.local.md`：某台机器的历史事实，只作参考，不要整段照抄。
