# poolchat —— 聊天池 Agent v1（pi + 飞书）

需求见 [需求文档.md](./需求文档.md)（唯一依据）。代码在 `app/`。

用户消息不直接发给 Agent，而是进**聊天池**；程序按 tick / 私聊 / 群里被@ / 计划到点 唤醒 Agent（单实例排队）。
**确定性逻辑全部是普通代码**，只有真正需要唤醒时才调用 LLM（pi）。

## 架构

```
飞书适配器(长连接) ─┐
QQ 适配器(空实现) ──┼→ Hub 入池(去重/身份映射/占位描述) → SQLite
mock 适配器(模拟) ──┘        │
                            ↓ onMessage
                 Scheduler: tick(3min，活跃时缩短) / 去抖(私聊、群@) / 计划匹配(Asia/Shanghai)
                            ↓ enqueue（同类合并）
                 RunQueue: 单实例 FIFO
                            ↓ handleWake（纯代码：暂停? 超每日上限? 有未读或到点计划? 否则不调 LLM）
                 PiEngine: 一个长期 pi 会话（关闭自动压缩）+ 自定义工具 + pi-death-loop-guard
                            ↓ 工具调用 send(pool, content)
                 Hub.send: [emoji:中文id] 解析 → 适配器发送 → 等 ~1s 确认 → 收集期间新消息作为返回值
```

| 文件 | 作用 |
|---|---|
| `src/core/db.ts` | SQLite：pools、messages、cursors、users/identities（跨平台 user_id）、plans/plan_fires、memories（来源池+可见范围）、handoffs、wake_log、usage_daily、kv（暂停开关） |
| `src/core/hub.ts` | 入池、未读收集与游标推进、send（表情解析/确认等待/收集新消息） |
| `src/core/scheduler.ts` | tick、活跃期短 tick、去抖（含最长等待）、群未@只等 tick |
| `src/core/queue.ts` | 单实例 FIFO 运行队列，排队中同类唤醒合并 |
| `src/core/plans.ts` / `time.ts` | 计划校验（ISO / cron，Asia/Shanghai）、到点匹配、同点只触发一次、停机补发/跳过、过期 |
| `src/core/emoji.ts` | 表情映射表加载；出站 `[emoji:中文id]` 解析（匹配不上原样输出，普通 `[xxx]` 不处理）；入站 `[名字]` → `[emoji:中文id]` |
| `src/core/loopguard.ts` | 防死循环：接入 pi-death-loop-guard；同语义内置实现（回退/测试用） |
| `src/agent/engine.ts` | pi SDK 封装：会话、用量统计、每日上限中途中止、超时、上下文上限 → 交接文档 → 新会话 |
| `src/agent/tools.ts` | 工具：`send`（唯一输出）、`list_pools`、`read_pool`、`plan_add/plan_update/plan_list`、`memory_add/memory_search` |
| `src/agent/prompt.ts` | 系统提示词与唤醒提示（紧凑格式，池用短别名 p1/p2 省 token） |
| `src/agent/faux.ts` | 桩 LLM（pi 自带 faux provider + 确定性脚本），用于模拟器/测试 |
| `src/adapters/` | `types.ts` 插件接口；`feishu.ts`；`qq.ts`（空实现）；`mock.ts` |
| `src/app.ts` / `main.ts` / `sim.ts` / `ctl.ts` | 组装与唤醒处理 / 正式入口 / 本地模拟器 / 运维命令 |

Agent 的普通回复（assistant 文本）只写进唤醒日志（`logs/wakes.jsonl` + SQLite `wake_log`），不会发给用户。

## 配置

`app/config/default.json`（全部阈值都在这里），可用 `app/config/local.json`（已 gitignore）或 `POOLCHAT_CONFIG=/path.json` 覆盖。主要项：

| 键 | 默认 | 说明 |
|---|---|---|
| `scheduler.tickMs` | 180000 | 默认 tick 3 分钟 |
| `scheduler.activeTickMs` / `activeWindowMs` | 60000 / 600000 | 活跃对话期间 tick 缩短，静默 10 分钟后恢复 |
| `scheduler.debounceMs` / `debounceMaxWaitMs` | 30000 / 120000 | 去抖静默时长 / 最长等待 |
| `send.confirmWaitMs` | 1000 | send 后等待时长 |
| `send.confirmViaApi` | false | true 时用飞书“获取消息”接口确认消息存在 |
| `loopGuard` | impl=pi-death-loop-guard, warn 5, block 10, abortAfterBlocks 1 | 连续 10 次一模一样 → 第 10 次被拦截并结束本轮 |
| `handoff.contextTokenLimit` | 60000 | 上下文 token 达到即交接 |
| `limits.dailyLlmCalls` / `dailyTokens` / `turnTimeoutMs` | 300 / 2000000 / 300000 | 每日上限（按 Asia/Shanghai 日期）与单轮超时 |
| `plans.missedPolicy` / `missedGraceMs` | catchup / 1 天 | 停机错过的触发：补发一次或跳过 |
| `llm.provider` / `llm.model` / `thinkingLevel` | deepseek / deepseek-flash / off | 任何 pi 支持的 provider/model（`npm run ctl -- models` 查看） |
| `emoji.table` | `./config/emoji-feishu.json` | 飞书内置表情映射表（中文id/别名 → emoji_type） |
| `emoji.map` | {} | 覆盖（优先于映射表）：`中文id → {sticker: 飞书file_key}` 或 `{text: "🙂"}` |
| `adapters.feishu.reactions` | true | 处理“表情回复”事件（需在后台订阅，见下） |
| `adapters.feishu.logRawEmoji` | true | 把含表情的入站原始 content 记到 app.log，便于核对 |
| `context.recentContextMessages` | 8 | 池首次出现在会话中时附带的近期上下文条数 |

## 环境变量（只从环境变量读取密钥，代码里没有任何密钥）

| 变量 | 必需 | 说明 |
|---|---|---|
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 是 | 飞书自建应用凭据 |
| 所选 LLM 的 key，如 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `ZAI_API_KEY` / `OPENROUTER_API_KEY` / `XAI_API_KEY` / `GEMINI_API_KEY` … | 是（一个） | pi 自己从环境变量读取，变量名见 pi 文档 providers.md |
| `POOLCHAT_CONFIG` | 否 | 额外配置文件路径 |
| `POOLCHAT_ENV_FILE` | 否 | `scripts/run.sh` 启动时 source 的 env 文件，默认 `~/.config/poolchat/env`（放仓库外，chmod 600） |
| `PI_OFFLINE`、`PI_TELEMETRY` | 否 | 程序默认设为 1 / 0（不自动刷新模型目录、关遥测） |

飞书后台需要：启用机器人；事件订阅方式选“使用长连接接收事件”，订阅 `im.message.receive_v1`；
权限 `im:message`、`im:message.p2p_msg`、`im:message.group_at_msg`；如需在群里未被@也能读到消息，再开 `im:message.group_msg`；
可选 `im:chat:readonly`（群名）、`contact:user.base:readonly`（发送者姓名，没有则显示“用户xxxx”）。

## 运行

需要 Node ≥ 22.19（pi 的要求）。本机已装在 `~/.local/node22`（系统自带的是 Node 20）：

```bash
export PATH=$HOME/.local/node22/bin:$PATH
cd /workspace/poolchat/app
npm install
npm test               # 单元测试 + 端到端测试（不需要任何凭据）
npm run demo           # 脚本化演示：mock 适配器 + 桩 LLM 走完整管线（约 40 秒）
npm run sim            # 交互模拟器：p/g/@ <会话> <文字>、tick、pause、resume、wakes、quit
npm run build          # 编译到 dist/

# 正式运行（缺少凭据会直接退出，不会空跑）
scripts/run.sh start   # nohup + 守护循环（崩溃自动重启、指数退避；退出码 2=凭据/配置问题不重启）
scripts/run.sh status | stop | restart | logs | fg

# 运维
npm run ctl -- pause | resume | status | usage | wakes 5 | pools | plans | handoffs | identities
npm run ctl -- link feishu <open_id> <user_id>   # 跨平台身份合并
npm run ctl -- models [provider]                 # pi 支持的模型、当前有凭据的 provider
```

本 box 没有 systemd / pm2，所以默认用 `scripts/run.sh`；另附 `ecosystem.config.cjs`（pm2）和 `scripts/poolchat.service`（systemd --user）供以后使用。
注意：box 重启后进程不会自己起来，需要再执行一次 `scripts/run.sh start`。

数据在 `app/data/`：`poolchat.db`、`sessions/`（pi 会话 JSONL，重启后继续最近会话）、`handoffs/*.md`（交接文档存档）、`pi-agent/`（pi 的 auth.json/models.json，可放自定义 OpenAI 兼容端点）。日志在 `app/logs/`。

## 桩 / 未实现

- **QQ**：只有接口和空实现（`src/adapters/qq.ts`）。
- **非文字消息**：只做占位描述（`[图片]`、`[语音]`、`[文件:名字]` 等），没有识别/转写。
- **表情映射表**：`emoji.map` 默认为空；飞书 sticker 需要 file_key（通常只能用收到过的表情包的 file_key），白名单待定。

## 飞书表情

- 映射表 `app/config/emoji-feishu.json`：覆盖飞书官方《表情文案说明》里全部 182 个 `emoji_type`，每项有微信式中文 id + 别名，`common: true` 的 38 个写进提示词。中文 id 是按官方表情图人工定的，客户端叫法不同时在 `aliases` 里补即可（改完重启）。
- 出站：Agent 写 `[emoji:捂脸]`；含内置表情的消息以**富文本 post** 发送（`{"tag":"emotion","emoji_type":"FACEPALM"}`，官方文档明确支持），纯文字仍发 text。id/别名都不认识 → 原样文字。
- 入站：post 里的 emotion、text 里的 `[名字]`（中文 id/别名/emoji_type，英文不分大小写）都转成 `[emoji:中文id]`；表情包 → `[表情包]`；`[文字](链接)` 不动。
- 表情回复（可选）：后台“事件与回调”订阅 `im.message.reaction.created_v1`，权限 `im:message.reactions:read`（或 `im:message:readonly`）。入池为 `[表情回复] 给你「…」点了 [emoji:强]`，不立即唤醒，等 tick。
- **潮汐闸门**：v1 不做。
- **桩 LLM**：`llm.provider = "faux"` 只用于模拟器和测试，正式入口会拒绝。
- 飞书适配器已按官方 SDK 编写，但因为没有凭据，**未连过真实飞书**。

## 与需求文档的差异 / 实现取舍

1. **pi 包名**：pi 现在发布为 `@earendil-works/pi-coding-agent`（旧名 `@mariozechner/pi-coding-agent` 停在 0.73）；新版要求 Node ≥ 22.19，所以在 `~/.local/node22` 装了 Node 22。
2. **防死循环**：用的就是 pi-death-loop-guard（通过它的 `LOOP_GUARD_*` 环境变量配置，值来自 config）。语义：工具名+参数+结果连续一致；前 9 次执行，第 10 次被拦截并 `abort` 结束本轮；第 5 次时先注入一条“别重复”的 steer 提醒（可配）。扩展加载失败时自动回退到同语义的内置实现（`loopGuard.impl: "builtin"` 也可强制）。
3. **发送确认**：飞书不会把机器人自己发的消息推回给机器人，所以默认“发送接口返回 message_id 即确认”；`send.confirmViaApi=true` 时再调用“获取消息”接口核对。等待时长照旧（1 秒），期间新消息照旧随返回值交给 Agent。
4. **计划状态**：除 待办/完成/取消 外增加 `expired`（过期时间到 / 一次性计划停机错过且策略为跳过）。
5. **一次唤醒读所有有未读的池**（不只是触发的那个池），合并处理，减少 LLM 调用。
6. **游标**：把消息交给 Agent 时推进；若 LLM 调用失败且一条都没发出，游标回滚，下次 tick 重试。
7. **“必要的近期上下文”**：只在某个池第一次出现在当前 pi 会话里时附带最近 N 条（之后会话里已有）；记忆同理每会话每人只注入一次。
8. **每日 token 上限**按 provider 报告的 totalTokens（含缓存读）计算，偏保守；超过时当前轮中止、后续唤醒跳过（消息保留未读）。
