# 坑与决策

记的是「当时看到什么、为什么这么改」，方便以后别重踩。

## 两个进程抢同一条飞书消息

**现象**：同一条私聊消息，有时回有时不回；图片时好时坏；日志里一会儿有一会儿没有；`outcome: skipped:nothing-new` 频繁出现。

**原因**：pm2 起了一个，手工 `bash scripts/run.sh fg` 又起了一个，两个都连同一个飞书 app。谁先写库谁赢，另一个拿到的是「重复消息已忽略」。

**当时怎么定**：`src/main.ts` 加单实例锁 `data/run/main.pid`——读到活着的 pid 就 `log.error` 然后 `exit(3)`；`ecosystem.config.cjs` 的 `stop_exit_codes` 加 3，免得它陷进重启循环。`npm run doctor` 会把「进程数 >1」标出来。

## 改了提示词但没生效

**原因**：pi 的 `continueRecent` 会把上个进程的会话文件读回来，system prompt 是**会话创建时**固化的，改文件等于白改。

**怎么办**：`engine.ts` 里 `freshNext = true`——每次进程启动都新开会话，上下文的唯一来源是池子。旧的会话文件在 `data/sessions-archive/`。

## 发了消息，期间来的图丢了

**原因**：`send` 里调 `takeUnread()` 推进了游标，把这条图片消息一起推过去了，下一轮就「没有未读」。

**怎么办**：`Hub.pendingMedia` 留档——`rememberPendingMedia()` 记下，下一轮 `takePendingMedia()` 合并进上下文。

## 图片被放大了

`sips -Z 1024` 是**等比缩放到长边 1024**，对 1×1 的图也是放大。需求是「只缩不放」。

**怎么办**：`media.ts` 先读原尺寸，只有长边真的 > 1024 才加 `-Z`。`test/media.test.ts` 锁死这条。

## 假超时日志

`Promise.race` 里的 8 秒计时器没取消，请求早就成功了，日志里还记一条「下载超时」。

**怎么办**：`clearTimeout` 挪进 `finally`。

## macOS 26 上 `sandbox-exec` 已经坏了

**实测**：任何带 filter 参数的 `file-read*` 规则——`(subpath "/usr")`、连 `(literal "/bin/echo")` 都算——直接 `Abort trap: 6`，rc=134。只有无参数的 `(allow file-read*)` 还能用，但那就等于限制不了读，`~/.config/poolchat/env` 照样能读。

**结论**：macOS 原生沙盒这条路排除，改用 Docker 容器（OrbStack 已经在跑）。

## `docker exec` 超时只杀 CLI

给 `execFile` 设 `timeout` 只会杀掉 docker 客户端，容器里的进程继续跑成孤儿。

**怎么办**：超时交给容器内——`timeout -s KILL <secs> sh -lc <cmd>`，命令走 `execFile` 参数数组，不经宿主 shell。

## pi 的 codemode 扩展 SDK 不自动加载

`tools` 列表里写 `"codemode"` 不报错，但永远不激活——模型会说「脚本跑完了」，其实调的是原生工具，绕过了整个沙盒。

**怎么办**：必须显式 `extensionFactories: [{ name: "codemode", factory: createCodemodeExtension() }]`。只有 CLI 才自动加载内置扩展。

## 飞书 `99992361 open_id cross app`

poolchat 用的是独立的飞书 app，拿不到 Hermes 那边的 open_id，**不能主动首发**。必须等人先发一条，之后的回复才正常。

## 几个决策

- **pm2 而不是 launchd 原生**：`sandbox`/`launchd` 那套要写 plist、管 KeepAlive，pm2 的 `save/restore` 更直接。自启靠 LaunchAgent 触发 `pm2 resurrect`。
- **每次新开会话**：见上面「改了提示词但没生效」。代价是跨进程没有对话记忆，全靠池子。
- **沙盒用容器不用 OS 沙盒**：见上面 `sandbox-exec` 那条。
- **沙盒有网**：主人明确要的（装包、clone、抓网页）。代价是它能把手上拿到的内容发出去——想收紧就把 `config.sandbox.shell.network` 改 `"none"`。
