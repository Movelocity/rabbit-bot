# 确定性排障决策树

从 `D0` 开始，按条件走，不要跳节点。每个节点只做三件事：跑指定命令、对照期望、按判断进入下一个节点。没有证据不要改配置、不要重启、不要删锁。

约定：

- 所有命令默认在 `<repo>/app` 下执行。
- 不打印任何密钥；检查环境变量只输出「set / missing」。
- `<技能目录>` 指本技能所在目录（`skills/rabbit-bot/deploy` 或 `~/.agents/skill-library/rabbit-bot/deploy`）。
- 每一步把命令和关键输出记进最终回传，不贴大段日志。

## D0：先拿基线

```bash
cd <repo>/app
npm run doctor
bash <技能目录>/scripts/deploy-check.sh --layer auto
```

判断：

| 结果 | 下一步 |
|---|---|
| `deploy-check` 有 `FAIL` | 按 FAIL 的检查项进入对应节点（下表） |
| 进程数 = 0 | D2 |
| 进程数 = 1 且 `/health` 正常 | D6（如果聊天不通）或直接做交付判定 |
| 进程数 > 1 | D8 |
| `doctor` 出现 `mode: 读取失败` | 说明 doctor 读旧键，先确认代码是当前版本：`git log --oneline -1`；不是则 D9 |

FAIL 检查项对照：

| 检查项 | 节点 |
|---|---|
| `platform` / `node` / `repo` / `deps` | D1 |
| `config` / `exit_enabled` / `env_*` / `llm_key` | D3 |
| `process` / `lock` | D2 / D4 |
| `api_health` | D5 |
| `docker` / `sandbox` | D10 |
| `pm2` | D2 |
| `webchat_roundtrip` | D6 |

## D1：环境不满足

```bash
node -v
npm -v
uname -s
node -e "require('better-sqlite3')(':memory:').exec('create table t(a)'); console.log('sqlite ok')"
```

判断：

- Node < 22.19：升级 Node。不要用系统自带旧 Node 硬跑。
- `MINGW*` / `MSYS*`：Windows 原生不支持，改用 WSL2；按 `docs/agent-environment.md` 在 WSL 内重做。
- `better-sqlite3` 报错：`npm rebuild better-sqlite3`，再跑一次冒烟。仍失败：`npm install --no-audit --no-fund` 后重试；确认 `build-essential python3 make g++` 已装（Linux/WSL2）。
- 目录不是 `<repo>/app`：回到正确目录，不要换仓库。

停在这里直到冒烟输出 `sqlite ok`。

## D2：进程没起来 / pm2 报错

```bash
pm2 list
pm2 logs rabbit-bot --lines 120 --nostream
```

判断：

| 日志关键字 / 状态 | 原因 | 下一步 |
|---|---|---|
| `exit 2` + `缺少环境变量` | env 缺 key | D3 |
| `exit 2` + `飞书、Matrix 和网页直聊都关着` | 三个出口全关 | D3 |
| `exit 2` + `LLM 配置不可用` | provider/key 不匹配 | D3 |
| `exit 3` / `已有实例在跑` | 单实例锁 | D4 |
| `EADDRINUSE` | 端口被占 | D12 |
| `ENOENT .../runtime/prompt/wake.md` | 空运行时 prompt 目录 + 旧版模板加载 | 升级到含模板回落的版本后 `npm run build`；临时可把 `app/prompts/*.md` 复制到 `<runtime>/prompt/` |
| `Cannot find module './dist/...'` | 没构建 | D9 |
| `模板 ... 缺少变量` | dist 与运行时提示词不一致 | D9 |
| `better-sqlite3` / `NODE_MODULE_VERSION` | 原生模块 | D1 |
| pm2 没装 | 没有 pm2 | `npm install -g pm2`；装不上就改用当前用户 npm prefix，不要 sudo 改系统 Node |
| pm2 里没有 rabbit-bot | 没启动 | `pm2 start ecosystem.config.cjs && pm2 save` |

启动后立刻回到 D0 复检。

## D3：配置 / 环境变量不对

先看配置：

```bash
cd <repo>/app
npx tsx -e 'import { loadConfig } from "./src/config.ts"; const c=loadConfig({}); console.log(JSON.stringify({exec:c.exec.shell.mode,feishu:c.adapters.feishu.enabled,matrix:c.adapters.matrix.enabled,webChat:c.webChat?.enabled!==false,api:c.api},null,2))'
```

再看 env 是否存在（只输出 set/missing）：

```bash
ENV_FILE="${RABBIT_BOT_ENV_FILE:-$HOME/.config/rabbit-bot/env}"
for v in DEEPSEEK_API_KEY FEISHU_APP_ID FEISHU_APP_SECRET MATRIX_TOKEN RABBIT_BOT_INJECT_TOKEN; do
  if grep -Eq "^${v}=.+" "$ENV_FILE" 2>/dev/null; then echo "$v set"; else echo "$v missing"; fi
done
stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null
```

判断：

- 三个出口（feishu / matrix / webChat）全 `false`：至少开一个。本机先用 `webChat.enabled: true`。
- feishu `true` 但 `FEISHU_APP_ID/SECRET` missing：补 env 或关掉 feishu。
- matrix `true` 但 `MATRIX_TOKEN` missing：补 env 或关掉 matrix。
- 默认 provider 是 `deepseek`，没有 `DEEPSEEK_API_KEY` 就 `LLM 配置不可用`：补 key，或改 `config/local.json` 的 `llm.provider/model`。
- env 权限不是 600：`chmod 600 "$ENV_FILE"`。
- `RABBIT_BOT_INJECT_TOKEN` 少于 16 位：重新生成；太短时注入口不启动。

改完 `npm run build && pm2 restart rabbit-bot`，回 D0。不要在聊天里回显 key。

## D4：单实例锁

```bash
cd <repo>/app
node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync("data/run/main.pid","utf8"));console.log(j.pid,j.startedAt,j.cmd)}catch(e){console.log("no-lock")}'
pgrep -fl "dist/main.js"
```

判断：

- pgrep 有进程，且 pid 与锁里一致：**正常，不要再起第二份**。回到 D0。
- pgrep 没进程：锁是残留。确认 `kill -0 <pid>` 返回非 0 后再删 `data/run/main.pid`，然后重启。
- 两个以上进程：D8。

禁止：没确认进程死透就删锁；这会制造双实例抢消息。

## D5：API 不在听

```bash
cd <repo>/app
npx tsx -e 'import { loadConfig } from "./src/config.ts"; const c=loadConfig({}); console.log(c.api)'
lsof -nP -iTCP:3738 -sTCP:LISTEN
curl -sS --max-time 3 http://127.0.0.1:3738/health
```

判断：

- `api.enabled=false`：改回 true，`npm run build && pm2 restart rabbit-bot`。
- 端口不是 3738：用实际端口访问；`deploy-check` 也会按配置端口检查。
- 端口无监听：进程没起（D2），或 `api.host` 绑错。本机用 `127.0.0.1`；容器访问宿主需要 `0.0.0.0`。
- `curl` 返回非 JSON：看 `pm2 logs`，多半是启动阶段异常。
- 端口被别的进程占：D12。

## D6：API 正常但网页直聊收不到回复

先做一次受控往返：

```bash
bash <技能目录>/scripts/deploy-check.sh --layer web --roundtrip
```

判断：

| 现象 | 原因 | 下一步 |
|---|---|---|
| `401` / `token` 相关 | API token 不对 | `TOKEN="${RABBIT_BOT_API_TOKEN:-$(cat data/run/api.token)}"`；确认 curl 带 `Authorization: Bearer $TOKEN` |
| `403 Web 登录没有开启` | `webChat.enabled=false` | 打开并重启 |
| `503 聊天中枢没有就绪` | 进程刚起或启动失败 | D2 |
| 发送返回 `201` 但 120 秒无自回复 | 模型/唤醒/额度问题 | 继续下面判断 |
| 收到自回复 | 正常 | 回到交付判定 |

120 秒无回复时按顺序查：

```bash
cd <repo>/app
pgrep -f "dist/main.js" | wc -l          # 期望 1
npm run ctl -- wakes 10                   # 看最近唤醒 outcome
npm run ctl -- usage                      # 看今日调用/额度
pm2 logs rabbit-bot --lines 80 --nostream # 找 LLM 错误 / 401 / 额度
```

- 进程数不是 1：D8。
- 唤醒是 `skipped:nothing-new`：消息没入池或游标已读完。重发一句新消息；仍 skip 就查 `web:web-chat` 池。
- 唤醒是 `ok` 但模型选择 `skip`：先发一句明确要回复的话（例如「请回复：好」）重试一次；仍 skip 记 WARN，说明链路通但模型选择沉默，不当作部署失败。
- 日志有 `401` / `invalid api key` / `没有可用凭据`：D3。
- 日志有 `ENOENT .../runtime/prompt/wake.md`：空运行时 prompt 目录 + 旧版模板加载；按 D2 对应行处理。
- 日志有额度/限额：调 `config/local.json` 的 `limits` 或 `npm run ctl -- usage` 看是哪一个上限。
- 日志有 `模板 ... 缺少变量`：D9。

## D7：飞书不回

按顺序，不跳步：

1. `pm2 logs rabbit-bot --lines 120 --nostream` 找飞书长连接、权限、事件错误。
2. `grep` 只确认 `FEISHU_APP_ID/SECRET` set（D3）。
3. 确认用户**已经私聊发过消息**。池由入站消息建立，没发过就不能主动发，也不能验证回复。
4. 确认事件是 `im.message.receive_v1`、走长连接、应用已发布、可用范围包含该用户。
5. 确认没有第二个服务用同一个飞书 app（两条长连接会互相抢事件）。
6. 查池：

```bash
TOKEN="${RABBIT_BOT_API_TOKEN:-$(cat data/run/api.token)}"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3738/v1/pools
```

- 没有 `platform: feishu` 的池：消息没进服务，回到 1/4。
- 有池、有用户消息、没有自回复：按 D6 的模型/额度/构建分支查。

飞书建应用细节见 `references/feishu-setup.md`。

## D8：同一句话回两次 / 图时好时坏

```bash
pgrep -fl "dist/main.js"
pm2 list
```

判断：

- 只有 pm2 一个进程：正常，回到 D0。
- pm2 一个 + 手工 `node dist/main.js` / `run.sh` 一个：停掉手工那个（`kill <pid>`），只留 pm2。
- pm2 里两个 rabbit-bot（名字不同或重复）：`pm2 delete <多余的名字>`，`pm2 save`。
- 锁和进程不一致：D4。

禁止直接 `pkill -f rabbit-bot` 一把杀，可能把当前 Agent 自己或别的服务带走；按 pgrep 的 pid 逐个处理。

## D9：改了代码 / 配置没生效

```bash
cd <repo>/app
git status --short
git log --oneline -1
ls -l dist/main.js src/main.ts
```

判断：

| 改了什么 | 必须做什么 |
|---|---|
| `config/prompt/*.md`、`persona.md` | `pm2 restart rabbit-bot`（不用 build） |
| 后端 `src/**` | `npm run build && pm2 restart rabbit-bot` |
| 前端 `webapp/src/**` | `npm run web:build && pm2 restart rabbit-bot` |
| `package-lock.json` / 依赖 | `npm install --no-audit --no-fund && npm run build && pm2 restart rabbit-bot` |
| `config/local.json` | 重新读配置：`pm2 restart rabbit-bot` |

`pm2 restart` 不编译，这是最常见的「进程 online 但行为没变」。构建后看 `dist/main.js` 的时间戳比 `src/main.ts` 新。

## D10：Docker / 沙盒容器问题

```bash
docker info --format '{{.OSType}}'
cd <repo>/app
npm run sbx -- status
docker inspect -f '{{.State.Status}} | {{.Config.Image}}' rabbit-bot-sbx 2>/dev/null
```

判断：

- `docker info` 失败：Docker 没启动 / 没装 / WSL2 集成没开。先解决 Docker，再谈沙盒。
- `OSType` 不是 `linux`：切回 Linux 容器模式；Windows 容器不支持这套参数。
- 容器不存在：`npm run sbx -- rebuild`，下次 terminal 会按 `config.exec.shell` 自建。
- 容器在跑但 `/work` 不可写：确认运行时目录宿主用户可写；WSL2 不要放 `/mnt/c`。
- 每条 terminal 都很慢 / 反复重建：查挂载 label：

```bash
docker inspect -f '{{index .Config.Labels "rabbit-bot.sandbox-mounts"}}' rabbit-bot-sbx
docker inspect -f '{{json .Mounts}}' rabbit-bot-sbx
```

host 模式没有容器，`sbx status` 显示 host 属正常；生产必须切回 docker。

## D11：执行器显示未安装（可选，不影响聊天）

```bash
which opencode || true
echo "${MIMO_BIN:-}" "${CODEX_BIN:-}" "${CLAUDE_BIN:-}"
```

判断：

- 不装执行器也能聊天，只是不能派任务。不要为了消掉这个警告去改核心配置。
- 要装：把对应 CLI 放到 PATH，或用 `MIMO_BIN` / `CODEX_BIN` / `CLAUDE_BIN` 指定绝对路径，然后 `pm2 restart rabbit-bot`。
- WSL2 内要装 Linux 版，不要指向 Windows 的 `.exe`。

## D12：端口被占

```bash
lsof -nP -iTCP:3738 -sTCP:LISTEN
lsof -nP -iTCP:3737 -sTCP:LISTEN
```

判断：

- 占用者是旧的 rabbit-bot：先 D4 / D8 处理进程，不要直接杀未知 pid。
- 占用者是别的服务：改 `config/local.json` 的 `api.port` / `inject.port`，重启。
- 只想临时看管理台：`npm run web -- --port 3748`（只读 demo，不接真实 IM）。

## 停止条件与回传

出现下面任一情况就停，不要继续猜：

- 缺 LLM Key、缺飞书 app id/secret、等飞书应用发布、等用户发首条消息。
- 需要 sudo / 管理员权限装 Docker、pm2、Node。
- 需要开放公网、改防火墙、设置 Web 密码。
- 数据损坏、SQLite 打不开、需要恢复备份。

回传必须带：

```text
卡在：D<x> / 哪一步
现象：命令 + 关键输出（不含密钥）
已试：做过哪些分支
缺什么：需要谁提供什么
下一步：拿到后执行哪条命令
```
