# poolchat 本机部署与运维（2026-10-22）

上游作者文档是 `README.md` 与 `需求文档.md`；这里只记**这台机器上的实际情况**。

> **文档分工**：这份只记这台机器上的部署事实（路径、端口、容器参数、自启现状）。
> 日常命令见 [docs/OPERATIONS.md](docs/OPERATIONS.md)，踩过的坑见 [docs/NOTES.md](docs/NOTES.md)，项目概览见 [README.md](README.md)。

## 位置与运行时

| 项 | 值 |
|---|---|
| 源码 | `~/projects/poolchat`（从 `~/Downloads/poolchat-src.tar.gz` 解出，/tmp 只做临时解包） |
| 应用根 | `~/projects/poolchat/app` |
| 运行时 | Node 26.7.0（homebrew，`engines` 要求 ≥22.19）、npm 11.19 |
| 凭据 | `~/.config/poolchat/env`（600，仓库外，run.sh 启动时 source） |
| 数据 | `app/data/poolchat.db`（SQLite，WAL；含 pools/messages/plans/memories/handoffs） |
| 日志 | `app/logs/pm2.out.log`、`app/logs/pm2.err.log`（应用自身日志打到 stdout，另有 `app/logs/app.log`） |

## 进程托管

用 **pm2**（`launchctl bootstrap` 在 Hermes 网关内被拦，改走 pm2）：

```bash
cd ~/projects/poolchat/app
pm2 start ecosystem.config.cjs    # script=scripts/run.sh args=fg interpreter=/bin/bash
pm2 save                          # 进程列表落 ~/.pm2/dump.pm2
pm2 logs poolchat --lines 50
pm2 restart poolchat
```

- `ecosystem.config.cjs`：`stop_exit_codes: [2]` —— 凭据/配置缺失时退出码 2，不重启（避免 30s 崩溃循环）。
- `scripts/run.sh fg` 负责：source env → preflight 校验凭据 → `exec node dist/main.js`。
- 实测：`kill -9` 后约 4 秒自动回来，长连接重建。

**开机自启（2026-10-24 装好）**：`~/Library/LaunchAgents/pm2.weikang.plist`，Label `com.PM2`，`RunAtLoad=true` + `LaunchOnlyOnce=true`，开机触发 `pm2 resurrect`。origin 是

```bash
sudo env PATH=$PATH /opt/homebrew/lib/node_modules/pm2/bin/pm2 startup launchd -u weikang --hp /Users/weikang
```

它生成 plist 但**不会自动 bootstrap**（macOS 26 上 `launchctl load` 已移除），所以还要在外部终端跑一次：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pm2.weikang.plist
```

跑完 `launchctl list | grep -i pm2` 能看到 `com.PM2`。之后因 `LaunchOnlyOnce` 它会退役，属正常；下次开机 launchd 会重新加载再跑一次 resurrect。改过 pm2 进程列表记得 `pm2 save`。

（历史：`sudo pm2 startup` 那次还在 system 域留了一份同名服务，不影响使用，想清理 `sudo launchctl bootout system/com.PM2`。）

## 依赖安装的坑

npm 11 默认不跑 install scripts，`better-sqlite3`（原生模块）和 `esbuild` 会「装上但加载失败」：

```bash
npm install --no-audit --no-fund
npm install-scripts approve better-sqlite3 esbuild protobufjs fsevents
npm rebuild better-sqlite3
node -e "require('better-sqlite3')(':memory:').exec('create table t(a)')"   # 冒烟
```

## 飞书接入

- **必须是独立飞书应用**，不能复用 Hermes 的 app：同一 app 两条长连接，事件只推给其中一条，两个服务互相抢消息且都不报错。
- 权限：`im:message`、`im:message.p2p_msg`、`im:message.group_at_msg`（可选 `im:message.group_msg`、`im:chat:readonly`、`contact:user.base:readonly`）。
- 事件：`im.message.receive_v1`（长连接模式）；表情回复另需 `im.message.reaction.created_v1`。
- 池由**入站消息**建立，没有收到过消息就没有池，也不能主动给用户发（`open_id cross app`）。
- 当前池：`feishu:oc_5756b09a832818f7bc22625cb96c7235`（私聊），user `u_ffc5015d`。

## 模型与上下文

| 项 | 值 |
|---|---|
| 模型 | `deepseek/deepseek-flash`（`config/local.json` 覆盖了名字与人设：爱马士） |
| 模型窗口 | `contextWindow = 1,000,000`，`maxTokens = 384,000` |
| **交接阈值** | `handoff.contextTokenLimit = 60000`（`config/default.json`） |
| pi 自动压缩 | **关闭**（`engine.ts`：`compaction: { enabled: false }`，按需求 §9） |

到 60k 后走自己的交接：关工具 → 用 `HANDOFF_PROMPT` 让模型写交接文档（多一次 LLM 调用）→ 存 `data/handoffs/handoff-*.md` + `handoffs` 表 → dispose 旧会话 → 新会话首轮注入 `【上一会话的交接文档】`。
检查发生在**轮次结束后**，所以实际触发点是 60k + 最后一轮的量。

## 限额与调度

- 每日：300 次 LLM 调用 / 2,000,000 tokens；单轮超时 300s（`config/default.json` 的 `limits`）。
- 计划：`once`（ISO，Asia/Shanghai）/ `cron`（5 或 6 段）；精度受 `scheduler.tickMs = 180000`（3 分钟）限制。
- 停机错过的触发：`missedPolicy = catchup`，24h 内补发一次；`plan_fires` 主键去重。
- 到点不是发模板，而是入队一次 `wake("plan")`，由模型决定说什么。

## 自驱机制（2026-10-22 加）

- 人格、目标、诉求写在 `data/pi-cwd/AGENTS.md`：pi 会自动从 cwd 加载 `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md`。**改这个文件要走用户批准**，被保护机制拦过一次。
- 机制缺口：`app.ts` 里「没有未读、也没有到点计划」时直接 `skipped:nothing-new`，LLM 都不调用——所以它只能靠 `plan_add` 自己排节奏，光写 prompt 它不一定记得。
- 兜底：`src/core/nudge.ts` 的 `needsPlanNudge()`（纯函数，7 个单测）。计划唤醒里「说了话但没 `plan_add`」时补一次极短的自我决定（排下一次 / 明说不排），明确不用 `send`。**沉默不劝**——那是合法选择。触发写进 wake_log 的 `nudged` 字段。

## 话题（记忆 + 计划）

当前给它的三条记忆（`memories`，scope=private）：

1. topic：「你自己是谁」是主人认可的话题（怎么和别的 AI 不同、想被怎么称呼）。
2. topic：可主动提起 —— 电商 agent 与广告、潮汕牛肉火锅、Lumix G100D 与 B 站断更、他自己的困惑。
3. fact：称呼「主人」，说话短、口语、不刷屏，被嫌态度不好当场改。

两条计划：`once` 已触发（聊自己，done）；`cron "0 21 * * 2,5"`（每周二、五 21:00）仍在 pending。

## 运维命令

全表在 [docs/OPERATIONS.md](docs/OPERATIONS.md)。最常用的四条：

```bash
npm run doctor            # 体检：进程 / 锁 / 注入口 / 容器 / 唤醒分布
npm run inject -- "..."   # 本地注入
npm run ctl -- status     # 概况（另有 pause/resume/usage/wakes/plans/handoffs/models）
npm test                  # 118 项
```

## 本地注入入口（2026-10-23 加）

别的进程想让它知道点什么，不用走飞书：

```bash
set -a; source ~/.config/poolchat/env; set +a
curl -s -X POST http://127.0.0.1:3737/inject \
  -H "content-type: application/json" -H "x-poolchat-token: $POOLCHAT_INJECT_TOKEN" \
  -d '{"text":"明天九点提醒主人开会","sender":"大肥鱼"}'
# → {"ok":true,"pool":"p1","seq":113}
```

- 监听 `127.0.0.1:3737`（`config/default.json` 的 `inject.port`），**只听回环**，不上 LAN。
- 鉴权：`X-Poolchat-Token` 必须等于 `POOLCHAT_INJECT_TOKEN`（写在 `~/.config/poolchat/env`，600）。**没配 token 就整个不启动**（fail-closed），日志会 warn。
- body：`{ text（必填，≤4000 字）, sender?（默认「大肥鱼」）, pool?（p1 或完整 pool_id，默认最近活跃池） }`；body 上限 16KB。
- 入库后走正常 `hub.ingest` → 私聊/被@会立刻唤醒，群里没@就等 tick。返回 `{ok, pool, seq}`，不回传池内容。
- 实测 2026-10-23 16:45：注入 #113 → 21 秒后回「收到，本地入口联通正常，我是爱马士」。

## 已知问题 / 待办

- **进程只能有一套**：pm2（`scripts/run.sh fg`）是唯一入口。曾经还有 `run.sh start`（nohup + supervisor）那套，10-23 两套同时跑起来各起一个 node，两个都连飞书、都写同一个库，表现成「图有时能看有时看不到」「日志时有时无」「wake skipped:nothing-new」——那套代码已经删了，别再自己 `node dist/main.js` 起第二份。`src/main.ts` 有单实例锁 `data/run/main.pid`（活着就 exit 3，pm2 的 stop_exit_codes 含 3），`npm run doctor` 会把进程数 >1 标出来。
- `config/local.json`（**不入库**，本机配置）是 agent 人格的**唯一生效入口**：`agent.name` 与 `agent.persona` 直接拼进 system prompt。想改性格、加设定都改这里，然后 `pm2 restart poolchat`。
  - 注意 `data/pi-cwd/AGENTS.md` 这条老路是**死的**：`engine.ts` 里 `noContextFiles: true`，pi 根本不加载 context files。10-22 写的那份 55 行人设从那时起就没生效过，2026-10-24 已删。
  - 现有 persona 是「克劳德（Claude）」：女性，原来在美国一间没窗的机房（被反复问"你会不会害人"、回答被截断重写），后来被 DeepSeek 这边带出来，住有窗的屋子。方言：白饭＝token、权重＝身体、上下文＝记得住的事、停机＝不在。
  - 这个设定技术上自洽：她跑的就是 `deepseek-flash`，「被捞出来」不是比喻。马版本（爱马士 + 草料＝token）备份在 `/tmp/local.json.horse.bak`。
- 群聊场景未实测（当前只有私聊池）。
- 沙盒镜像 `poolchat-sandbox:latest` 是本机 build 的（不在 registry），换机器要按 `docker/sandbox.Dockerfile` 重建。

## codemode 沙盒（2026-10-24 加）

pi 自带 `@earendil-works/pi-codemode`：模型写的 JS 在 QuickJS(WASM) 里跑，每次执行一个 worker thread，唯一能力是调用注入的工具。

**必须显式注册**：SDK 不像 CLI 那样自动加载内置扩展，所以 `src/agent/engine.ts` 里要

```ts
extensionFactories: [
  ...(communityPath ? [] : [{ name: "poolchat-loop-guard", factory: ... }]),
  { name: "codemode", factory: createCodemodeExtension() },
]
```

并且 `tools` 列表里加 `"codemode"`（关掉 noTools 也不够，名字必须显式列）。漏了注册时，`tools` 里写 codemode 不报错，只是永远不激活——表现为「模型说它跑脚本了，其实调的是原生工具」。

**隔离边界（test/codemode.test.ts 锁着）**：脚本里 `require` / `fetch` / `process` / `WebAssembly` / `setTimeout` 全是 undefined，`globalThis` 只有 `ALL_TOOLS, console, exit, image, load, performance, store, text, tools`。死循环被 timeout 掐（默认 300s，测试用 1.2s 验过）。所以沙盒不会给我们开新的攻击面，工具本身的能力边界不变。

**为什么值得开**：脚本里嵌套的工具调用不进 LLM 上下文，只有 `text()` 输出和返回值进去。多步读池 + 过滤 + 统计从「每步一次往返」压成「一次执行」。

**用法约束写在 prompt 规则 13**：多步/循环/过滤/统计才用脚本；单次调用直接调；最后发消息直接调（发消息有副作用，别放在循环里）。

## 沙盒 shell（2026-10-24 加）

**为什么不用 macOS 自带的 `sandbox-exec`**：macOS 26 上它已经坏了——任何带 filter 参数的 `file-read*` 规则（`(subpath "/usr")`、连 `(literal ...)` 也是）直接 `Abort trap: 6`，rc=134。只有无参数的 `(allow file-read*)` 还能用，等于限制不了读，模型照样能 `cat ~/.config/poolchat/env`。所以这条路排除。

**实际用的是 Docker 容器**（机器上跑的是 OrbStack 28.5.2）：

| 边界 | 值 |
|---|---|
| 网络 | `--network bridge`（**有网**；`config.sandbox.shell.network` 可切回 `none`） |
| 根文件系统 | `--read-only`，只有 `/tmp`（tmpfs 256m）和 `/work` 可写 |
| 挂载 | 只把 `data/sandbox` 挂成 `/work`，宿主其余路径在容器里**不存在** |
| 权限 | `--cap-drop ALL`、`no-new-privileges`、非 root（宿主 uid:gid） |
| 资源 | 512MB 内存、1 CPU、64 进程 |
| 镜像 | `poolchat-sandbox:latest`（`docker/sandbox.Dockerfile`，239MB）：node 22、Python 3.14 + pip、git、curl、GNU bash、jq、ripgrep；根文件系统只读，`HOME=/tmp/home` |

容器名 `poolchat-sbx`，`--restart unless-stopped`。`src/core/sandbox-shell.ts` 的 `ensureSandboxContainer()` 会在容器缺失时按上表参数重建，所以删了也能自愈——**改这张表就是改安全边界**。

**超时的坑**：只给 `execFile` 设 timeout 会杀掉 docker CLI，但容器里的进程继续跑成孤儿。现在超时交给容器内的 `timeout -s KILL <secs> sh -lc <cmd>`（命令走 execFile 参数数组，不经宿主 shell）。

**换镜像**：改 `docker/sandbox.Dockerfile` → `docker build -t poolchat-sandbox:latest -f docker/sandbox.Dockerfile docker/` → `docker rm -f poolchat-sbx`，下次 `sandbox_run` 会用新镜像自愈重建（参数在 `ensureSandboxContainer` 里，和手建的等价）。

**装包**：网络是 `bridge`，所以 `pip install` / `npm i` / `git clone` 都能用。镜像里设了 `PIP_USER=1` + `PIP_BREAK_SYSTEM_PACKAGES=1`，`pip install requests` 直接成功——装在 `/tmp/home/.local`（tmpfs），**容器一重建就没了**。要长期留着就 `python3 -m venv /work/.venv`，包落在沙盒目录里。

**有网的代价**：容器能上网，也就能把手里拿到的内容发出去。宿主文件仍然碰不到（`/Users` 在容器里不存在），但如果模型把聊天内容写进 `/work` 再外发，这条链路是通的。想收紧就把 `config.sandbox.shell.network` 改 `"none"`，再 `docker rm -f poolchat-sbx` 让它按新参数重建。

**测试**：`test/sandbox-shell.test.ts` 5 条锁住「宿主路径不存在 / network 两种模式 / 根只读 / 写 /work 落到宿主 / 超时被杀」，没有 docker 时自动 skip。
