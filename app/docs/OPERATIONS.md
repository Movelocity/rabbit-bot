# 运维命令

所有日常操作都在这里。命令都在 `app/` 目录下跑。

## 一屏体检

```bash
npm run doctor
```

输出：pm2 进程与数量（>1 会标红）、单实例锁 `data/run/main.pid`、注入口 3737、沙盒容器状态、最近 24h 唤醒分布、data/logs 体积、日志末尾三行。

## 起停

```bash
npm run build                 # tsc
pm2 restart rabbit-bot          # 改完代码必须 build + restart，缺一不可
pm2 logs rabbit-bot --lines 50
pm2 list
```

**不要同时用 pm2 和 `bash scripts/run.sh fg`**——两个进程会抢同一条飞书消息，表现是「图有时能看有时看不到」「日志时有时无」。

## 注入

```bash
npm run inject -- "帮我看下池子里最近聊了什么"          # sender 默认「大肥鱼」
npm run inject -- "..." 某人                          # 指定发送者
```

背后是 `POST http://127.0.0.1:3737/inject` + `x-rabbit-bot-token`。服务只监听回环，token 没配或不对一律拒绝（fail-closed）。

## 沙盒容器

```bash
npm run sbx -- status        # 状态 + 边界参数 + /work 内容
npm run sbx -- shell         # 进容器逛（cwd=/work）
npm run sbx -- rebuild       # 删容器，下次 sandbox_run 按 config 自建
npm run sbx -- image         # 改过 docker/sandbox.Dockerfile 后重建镜像
npm run sbx -- clean         # 清空 data/sandbox（会二次确认）
```

容器 `rabbit-bot-sbx`，边界写在 `src/core/sandbox-shell.ts` 的 `ensureSandboxContainer()` 里，**改那里就是改安全边界**。

## 运维查询（ctl）

```bash
npm run ctl -- status         # 概况
npm run ctl -- pause          # 暂停主动唤醒（不丢消息）
npm run ctl -- resume
npm run ctl -- usage          # 今日 LLM 调用 / token 用量
npm run ctl -- wakes 20       # 最近 20 次唤醒
npm run ctl -- plans          # 计划列表
npm run ctl -- handoffs       # 上下文交接记录
npm run ctl -- models         # 可用 provider / 模型
```

## 测试

```bash
npm test                      # 118 条，全部离线；容器沙盒那 5 条没有 docker 会自动 skip
npm run typecheck
```

## 故障速查

| 现象 | 先看这个 |
|---|---|
| 不回消息 | `npm run doctor` → 进程数是不是 0；`pm2 logs rabbit-bot` |
| 同一句话回两次 / 图时好时坏 | 进程数 >1。`pgrep -f dist/main.js`，杀多余的那个 |
| `skipped:nothing-new` 大量出现 | 双进程抢游标的历史痕迹，或 send 期间又来了消息（图会走 pendingMedia） |
| 容器相关工具报错 | `npm run sbx -- status`；容器不在就 `npm run sbx -- rebuild` 让它自建 |
| 装不上 pip 包 | 容器有网。`PIP_USER` 已设，`pip install x` 直接可用；要长期留就 `python3 -m venv /work/.venv` |
| 提示词改了没生效 | 每次进程启动都新开会话（`freshNext=true`），改完要 build + restart |

## 开机自启

`~/Library/LaunchAgents/pm2.weikang.plist`（Label `com.PM2`，`RunAtLoad` + `LaunchOnlyOnce` + `KeepAlive`），开机时触发 `pm2 resurrect`，按 `~/.pm2/dump.pm2` 拉起进程列表。

改过 pm2 进程列表之后要 `pm2 save`，否则下次启动还是旧的一份。

加载/重载 plist 必须在**外部终端**做（Hermes 网关会拦 `launchctl bootstrap`）：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/pm2.weikang.plist
launchctl list | grep -i pm2     # 看到 com.PM2 就成了
```
