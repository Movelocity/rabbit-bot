# rabbit-bot —— 聊天池 Agent（pi + 多 IM）

需求见 [需求文档.md](./需求文档.md)（唯一依据）。代码在 `app/`。

支持飞书、Matrix 等 IM。IM 适配层是插件接口（`IMAdapter`），新增平台只需要实现并注册适配器，池 / 调度 / Agent 都不用改。

用户消息不直接发给 Agent，而是进**聊天池**；程序按 tick / 私聊 / 群里被@ / 计划到点 唤醒 Agent（单实例排队）。
**确定性逻辑全部是普通代码**，只有真正需要唤醒时才调用 LLM（pi）。

## 架构

所有适配器都实现统一的 `IMAdapter` 插件接口：

```
飞书适配器(长连接) ─┐
Matrix 适配器(/sync) ┼→ Hub 入池(去重/身份映射/占位描述) → SQLite
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
| `src/core/scheduler.ts` | 群聊 tick、任务事件 batch tick、活跃期短 tick、私聊/被@去抖（含最长等待） |
| `src/core/queue.ts` | 单实例 FIFO 运行队列，排队中同类唤醒合并 |
| `src/core/reflection.ts` | 自省：没人说话时让模型想一下，输出 `urgency`（有多想说）+ 念头 |
| `src/core/gate.ts` | 主动开口的六道门：低分 / 刚聊完 / 夜间 / 冷却 / 日上限 / 连说没人回 |
| `src/core/plans.ts` / `time.ts` | 计划校验（ISO / cron，Asia/Shanghai）、到点匹配、同点只触发一次、停机补发/跳过、过期 |
| `src/core/emoji.ts` | 表情映射表加载；出站 `[emoji:中文id]` 解析（匹配不上原样输出，普通 `[xxx]` 不处理）；入站 `[名字]` → `[emoji:中文id]` |
| `src/core/loopguard.ts` | 防死循环：接入 pi-death-loop-guard；同语义内置实现（回退/测试用） |
| `src/core/tool-call.ts` | 工具调用的判定（`didSend` / `didSkip` / `didPlanAdd` / `didPlanDone`）：二级入口看名字不够，还要看 action |
| `src/core/approval.ts` / `task-approval.ts` | 宿主机命令审批 / 任务发布审批：审批提示走系统消息、超时按拒绝；只有被闸门认领的裁决动作不进池，同一聊天里的正常文字照常入池（审批房可能就是私聊） |
| `src/agent/engine.ts` | pi SDK 封装：会话、用量统计、每日上限中途中止、超时、上下文上限 → 交接文档 → 新会话 |
| `src/agent/tools.ts` | 工具：`chat`（send/skip/view/list/search）、`memory`（recent/search/add/expire/update）、`plan`（add/done/list）、`approval`、`task`、`worker`、`read_file`/`write_file`/`terminal`、`rb`（只做运维查询） |
| `src/agent/prompt.ts` | 系统提示词与唤醒提示（紧凑格式，池用短别名 p1/p2 省 token） |
| `src/agent/faux.ts` | 桩 LLM（pi 自带 faux provider + 确定性脚本），用于模拟器/测试 |
| `src/adapters/` | `types.ts` 插件接口；`feishu.ts`；`matrix.ts`；`mock.ts` |
| `src/app.ts` / `main.ts` / `sim.ts` / `ctl.ts` | 组装与唤醒处理 / 正式入口 / 本地模拟器 / 运维命令 |

Agent 的普通回复（assistant 文本）只写进唤醒日志（`logs/wakes.jsonl` + SQLite `wake_log`），不会发给用户。

## IM 适配器

| 适配器 | 状态 | 凭据 / 配置 | 说明 |
|---|---|---|---|
| 飞书 | 内置，默认开启 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 长连接接收事件；支持飞书表情与 reaction（表情回复） |
| Matrix | 内置，默认关闭 | `MATRIX_TOKEN` | 自建 Continuwuity；`/sync` 长轮询；加密房间不解密；私聊按房间成员数 ≤2 判定 |
| mock | 测试 / 模拟器用 | 无 | `npm run sim` / `npm run demo` / 测试用，不连真实 IM |

其他 IM：实现 `IMAdapter`（`src/adapters/types.ts`）并注册即可，池 / 调度 / 工具都不变。

## 配置

`app/config/default.json`（全部阈值都在这里），可用 `app/config/local.json`（已 gitignore）或 `RABBIT_BOT_CONFIG=/path.json` 覆盖。主要项：

| 键 | 默认 | 说明 |
|---|---|---|
| `scheduler.tickMs` | 180000 | 群聊 tick 周期（默认 3 分钟） |
| `scheduler.taskTickMs` | 180000 | 任务事件 tick 周期：窗口内的任务事件合并成一次唤醒，不逐条叫醒 |
| `scheduler.privateWakeMs` | 5000 | 私聊消息后的唤醒延迟（被 @ 仍走 `debounceMs` 快速去抖） |
| `scheduler.activeTickMs` / `activeWindowMs` | 60000 / 600000 | 活跃对话期间 tick 缩短，静默 10 分钟后恢复 |
| `scheduler.debounceMs` / `debounceMaxWaitMs` | 5000 / 20000 | 群聊被 @ 时的去抖静默时长 / 最长等待 |
| `send.confirmWaitMs` | 1000 | send 后等待时长 |
| `send.confirmViaApi` | false | true 时用飞书“获取消息”接口确认消息存在 |
| `loopGuard` | impl=pi-death-loop-guard, warn 5, block 10, abortAfterBlocks 1 | 连续 10 次一模一样 → 第 10 次被拦截并结束本轮 |
| `handoff.contextTokenLimit` | 60000 | 上下文 token 达到即交接 |
| `limits.dailyLlmCalls` / `dailyTokens` / `turnTimeoutMs` | 300 / 2000000 / 300000 | 每日上限（按 Asia/Shanghai 日期）与单轮超时 |
| `plans.missedPolicy` / `missedGraceMs` | catchup / 1 天 | 停机错过的触发：补发一次或跳过 |
| `taskApproval` | enabled=false, target=origin, platform=feishu, roomId="", ownerIds=[], timeoutMs=86400000 | 任务发布审批：target=origin 发到任务发起的聊天，target=room 发到固定审批房；主人贴 OK 才启动。关掉时回退 Web 任务页 |
| `llm.provider` / `llm.model` / `thinkingLevel` | deepseek / deepseek-flash / off | 任何 pi 支持的 provider/model（`npm run ctl -- models` 查看） |
| `emoji.table` | `./config/emoji-feishu.json` | 飞书内置表情映射表（中文id/别名 → emoji_type） |
| `emoji.map` | {} | 覆盖（优先于映射表）：`中文id → {sticker: 飞书file_key}` 或 `{text: "🙂"}` |
| `adapters.feishu.reactions` | true | 处理“表情回复”事件（需在后台订阅，见下） |
| `adapters.feishu.logRawEmoji` | true | 把含表情的入站原始 content 记到 app.log，便于核对 |
| `context.recentContextMessages` | 8 | 池首次出现在会话中时附带的近期上下文条数 |
| `runtimeDir` | `~/.config/rabbit-bot/runtime` | 人设 / 提示词 / 话题库的真身目录（`RABBIT_BOT_RUNTIME` 可改），见 app/README「定制它」 |

任务事件（进度、开始、退出、note、完成、失败、阻塞）都不逐条唤醒 UFA；它们先写进任务池，由下一次任务事件 tick 批量带走。审批仍走立即唤醒。

**任务发布不用开 Web**：`taskApproval` 开启后，UFA 建的任务会以一条带目标 / 产出 / 约束 / 验收 / 目录的提示发到任务发起时的聊天（`target=origin`，默认推荐），也可以发到固定审批房（`target=room`）；主人给那条消息贴 OK 表情就启动执行器，贴 No 或超时按拒绝。提示走系统消息、不建池，表情裁决也不入 Agent 的会话上下文；原聊天里的文字聊天照常，所以不会干扰正常对话。固定审批房可以和宿主机命令审批共用（`approval.roomId`）。

**人设默认是简单助手**（`agent.name=小池`），仓库里不含任何人的真身设定：运行时目录有 `persona.md` 就用它，没有就用 `agent.persona` 那一句。想给它性格，照着 `app/config/persona.example.md` 写一份放进运行时目录。

## 环境变量（只从环境变量读取密钥，代码里没有任何密钥）

| 变量 | 必需 | 说明 |
|---|---|---|
| `FEISHU_APP_ID`、`FEISHU_APP_SECRET` | 飞书适配器启用时必需 | 飞书自建应用凭据 |
| `MATRIX_TOKEN` | Matrix 适配器启用时必需 | Matrix 账号的 access token |
| 所选 LLM 的 key，如 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `ZAI_API_KEY` / `OPENROUTER_API_KEY` / `XAI_API_KEY` / `GEMINI_API_KEY` … | 是（一个） | pi 自己从环境变量读取，变量名见 pi 文档 providers.md |
| `RABBIT_BOT_CONFIG` | 否 | 额外配置文件路径 |
| `RABBIT_BOT_ENV_FILE` | 否 | `scripts/run.sh` 启动时 source 的 env 文件，默认 `~/.config/rabbit-bot/env`（放仓库外，chmod 600） |
| `PI_OFFLINE`、`PI_TELEMETRY` | 否 | 程序默认设为 1 / 0（不自动刷新模型目录、关遥测） |

至少启用一个真实适配器（飞书或 Matrix）；适配器开关见 `config/default.json` / `config/local.json` 的 `adapters.*.enabled`。

飞书适配器还需要在飞书后台：启用机器人；事件订阅方式选“使用长连接接收事件”，订阅 `im.message.receive_v1`；
权限 `im:message`、`im:message.p2p_msg`、`im:message.group_at_msg`；如需在群里未被@也能读到消息，再开 `im:message.group_msg`；
可选 `im:chat:readonly`（群名）、`contact:user.base:readonly`（发送者姓名，没有则显示“用户xxxx”）。

## 运行

需要 Node ≥ 22.19（pi 的要求）。本机已装在 `~/.local/node22`（系统自带的是 Node 20）：

```bash
export PATH=$HOME/.local/node22/bin:$PATH
cd /workspace/rabbit-bot/app
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
npm run ctl -- link feishu <open_id> <user_id>     # 跨平台身份合并（飞书）
npm run ctl -- link matrix <@user:server> <user_id>  # 同理可合并 Matrix 身份
npm run ctl -- models [provider]                 # pi 支持的模型、当前有凭据的 provider
```

本 box 没有 systemd / pm2，所以默认用 `scripts/run.sh`；另附 `ecosystem.config.cjs`（pm2）和 `scripts/rabbit-bot.service`（systemd --user）供以后使用。
注意：box 重启后进程不会自己起来，需要再执行一次 `scripts/run.sh start`。

数据在 `app/data/`：`rabbit-bot.db`、`sessions/`（pi 会话 JSONL，重启后继续最近会话）、`handoffs/*.md`（交接文档存档）、`pi-agent/`（pi 的 auth.json/models.json，可放自定义 OpenAI 兼容端点）。日志在 `app/logs/`。

## 桩 / 未实现

- **更多 IM 适配器**：目前内置飞书 + Matrix，其他平台（QQ / 微信等）按 `IMAdapter` 接口接；Matrix 加密房间暂不解密。
- **非文字消息**：只做占位描述（`[图片]`、`[语音]`、`[文件:名字]` 等），没有识别/转写。
- **表情映射表**：`emoji.map` 默认为空；飞书 sticker 需要 file_key（通常只能用收到过的表情包的 file_key），白名单待定。

## 飞书表情（飞书适配器专属）

- 映射表 `app/config/emoji-feishu.json`：覆盖飞书官方《表情文案说明》里全部 182 个 `emoji_type`，每项有微信式中文 id + 别名，`common: true` 的 38 个写进提示词。中文 id 是按官方表情图人工定的，客户端叫法不同时在 `aliases` 里补即可（改完重启）。
- 出站：Agent 写 `[emoji:捂脸]`；含内置表情的消息以**富文本 post** 发送（`{"tag":"emotion","emoji_type":"FACEPALM"}`，官方文档明确支持），纯文字仍发 text。id/别名都不认识 → 原样文字。
- 入站：post 里的 emotion、text 里的 `[名字]`（中文 id/别名/emoji_type，英文不分大小写）都转成 `[emoji:中文id]`；表情包 → `[表情包]`；`[文字](链接)` 不动。
- 表情回复（可选）：后台“事件与回调”订阅 `im.message.reaction.created_v1`，权限 `im:message.reactions:read`（或 `im:message:readonly`）。入池为 `[表情回复] 给你「…」点了 [emoji:强]`，不立即唤醒，等 tick。
- **潮汐闸门**：v1 不做。
- **桩 LLM**：`llm.provider = "faux"` 只用于模拟器和测试，正式入口会拒绝。

## 与需求文档的差异 / 实现取舍

1. **pi 包名**：pi 现在发布为 `@earendil-works/pi-coding-agent`（旧名 `@mariozechner/pi-coding-agent` 停在 0.73）；新版要求 Node ≥ 22.19，所以在 `~/.local/node22` 装了 Node 22。
2. **防死循环**：用的就是 pi-death-loop-guard（通过它的 `LOOP_GUARD_*` 环境变量配置，值来自 config）。语义：工具名+参数+结果连续一致；前 9 次执行，第 10 次被拦截并 `abort` 结束本轮；第 5 次时先注入一条“别重复”的 steer 提醒（可配）。扩展加载失败时自动回退到同语义的内置实现（`loopGuard.impl: "builtin"` 也可强制）。
3. **发送确认**：飞书不会把机器人自己发的消息推回给机器人，所以默认“发送接口返回 message_id 即确认”；`send.confirmViaApi=true` 时再调用“获取消息”接口核对。等待时长照旧（1 秒），期间新消息照旧随返回值交给 Agent。
4. **计划状态**：除 待办/完成/取消 外增加 `expired`（过期时间到 / 一次性计划停机错过且策略为跳过）。
5. **一次唤醒读所有有未读的池**（不只是触发的那个池），合并处理，减少 LLM 调用。
6. **游标**：把消息交给 Agent 时推进；若 LLM 调用失败且一条都没发出，游标回滚，下次 tick 重试。
7. **“必要的近期上下文”**：只在某个池第一次出现在当前 pi 会话里时附带最近 N 条（之后会话里已有）；记忆同理每会话每人只注入一次。
8. **每日 token 上限**按 provider 报告的 totalTokens（含缓存读）计算，偏保守；超过时当前轮中止、后续唤醒跳过（消息保留未读）。

## 借鉴

- **主动开口机制参考 [Shikigami Protocol](https://github.com/Shikigami-Lab/Shikigami-Protocol)（AGPL-3.0）**：自省（模型自填 `urgency`）→ 六道门 → 开口 这条链路，以及「冷却随 urgency 缩放」「连续说了没人回就收」「每次决策记 `skip_reason`」三个做法，思路来自它的 ASE（Autonomous Self-Expression）。**只借鉴思路，没有复制代码**（对方 AGPL-3.0，本仓库不复用其任何源文件）。
- 领域契约（`TURN_STATES` / `ACTIONS` / `SEGMENT_MODES`、决策次数与投递次数分账）参考 [astrbot_plugin_private_companion](https://github.com/menglimi/astrbot_plugin_private_companion) 的 `decision/contract.py` 与 `proactive/budget.py`，同样只取概念。
