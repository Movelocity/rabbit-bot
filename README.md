<div align="center">

<img src="app/webapp/public/logo.png" width="120" alt="rabbit-bot logo">

<h1>rabbit-bot</h1>

<p><strong>会等、会挑时机、会自己干活的 IM Agent。</strong><br>
不是那种你发一句它回一句的聊天机器人。</p>

<p>接上飞书或 Matrix，它住进你的聊天里。消息先进「聊天池」，调度器决定何时叫醒模型，其余都是确定性代码。</p>

<p>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7.x-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://sqlite.org"><img alt="SQLite" src="https://img.shields.io/badge/SQLite-local-003B57?logo=sqlite&logoColor=white"></a>
  <a href="https://pi.dev"><img alt="pi" src="https://img.shields.io/badge/engine-pi-111111"></a>
  <img alt="IM" src="https://img.shields.io/badge/IM-Feishu%20%7C%20Matrix-00A3FF">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
</p>

</div>

---

## 它和普通 Bot 不一样

普通 Bot 收到消息就调模型、回一句。代价是每条消息都在烧 token，群一热闹就刷屏，还得假装自己记得上下文。

| 普通 IM Bot | rabbit-bot |
|---|---|
| 每条消息都触发一次 LLM | 有未读、有日程、被 @，才叫醒模型 |
| 回复越快越好 | 该沉默时沉默，该接话时接话 |
| 上下文硬塞聊天记录 | 池子就是上下文，游标精确到「读到哪」 |
| 一个平台一套逻辑 | 飞书 / Matrix 共用一套池与调度 |

## 三个关键点

- **省钱**：没未读不唤醒；活跃期自动缩短 tick；日调用、token、花费三道上限。
- **像个人**：有人设和说话规则，会主动开口，防客服腔、防复读；群里没 @ 也能自己判断接不接话。
- **干得了活**：聊天归 UFA，任务交给独立进程的 WA，能跑长任务、回传进度和产出，全程可审计。

## 一条消息的旅程

```
飞书 / Matrix ──→ 聊天池(SQLite) ──→ 调度器 ──→ 单实例队列 ──→ pi Agent
                                      ↑                              │
                         tick / 私聊去抖 / 群@ / 日程                 │
                                      └────── send(pool, text) ←─────┘
```

没轮到它，就不烧 token；轮到它，也只读该读的未读和近期上下文。

## 一直在线，但不一直烧 token

「始终在线」在这里是一种体验，不是让模型挂在进程里等消息。没人说话时就睡在数据库里；被叫醒只干一件事——读该读的未读、做判断、结束再睡。

撑起这套节奏的都是确定性代码，我们自己一块块搭的：

| 我们的设计 | 解决什么 |
|---|---|
| 聊天池(SQLite) + 游标 | 消息先落池排队，连发的合到一次读；游标记着「读到哪」，中途挂了也能接着读，不丢事件 |
| tick / 私聊去抖 / 群 @ | 私聊留个短窗口把连发攒齐；群聊平时潜水，被点名才立刻看这一屏；日程到点也算一次唤醒 |
| 带有效期的记忆 | 每条写明从何时成立、顶掉哪条，过期自己失效；跨会话不靠「模型还记得上次说了啥」 |
| 越权审批门 | 敏感命令不自己拍板，发到审批聊天等主人点头，超时按拒绝；任务也要先等 OK 才启动 |
| `chat.send` / `skip` | 发送是唯一出口，说不说由它判断；没话说就 `skip`，进度按 tick 合批，不逐条刷屏 |

**真正的分水岭是 UFA / WA 双层。** UFA（user-facing agent）是有人格的那一个——陪你聊、判断该不该开口，但不碰重活；WA（working agent）是独立进程（opencode / mimo），没人设，只管把任务做完，进度和产物经任务面板与 `shared/` 回传。两边不共享上下文，也不在同一个进程里：长任务跑多久都搅不乱聊天节奏，聊天的人味儿也不会被执行细节冲淡。在线的是体验，干活的是另一个人。

Anthropic 近期在《Building always-on agents》里把这类系统总结成 Inbox / Timer / Memory / Permissions / Outbox 五件套（[解读](https://x.com/shao__meng/status/2121427594260398327)），和我们这套设计不谋而合，非常相似——读者也可以借这套词来理解 rabbit-bot 的框架。

## 30 秒跑起来

不需要 API Key、IM 账号或 Docker：

```bash
cd app
npm install
npm run demo
```

mock 适配器 + 桩 LLM 会走完整管线：入池、去抖、唤醒、工具调用、发送、日志。接真实飞书 / Matrix 看 [app/README.md](app/README.md)。

## 适合谁

- 想给自己的飞书 / Matrix 接一个**有边界感**的私人助理
- 在意 token 成本和消息噪音，而不是「每条都秒回」
- 需要任务能落地、过程可审计，而不是只会在聊天框里说漂亮话
- 愿意自己部署、自己掌控数据和密钥

不适合：高并发客服、实时语音、开箱即用的多租户 SaaS。

## 技术底座

Node ≥ 22.19 · TypeScript · SQLite · [pi](https://pi.dev) · React 管理台

调度、去重、游标、预算、审批、防死循环、上下文交接都是普通代码；LLM 只在真正需要说话或做判断时出场。

## 文档

| 文档 | 内容 |
|---|---|
| [需求文档.md](需求文档.md) | 产品边界与设计依据 |
| [app/README.md](app/README.md) | 部署、配置、管理台、任务模型 |
| [docs/agent-environment.md](docs/agent-environment.md) | **多环境部署**：macOS / Linux / Windows WSL2、Docker、常见踩坑 |
| [docs/](docs/) | 架构、记忆、主动开口、沙盒、业务地图 |
| [docs/TROUBLESHOOT-executor-and-approval.md](docs/TROUBLESHOOT-executor-and-approval.md) | **踩坑手册**：执行器秒退、审批不发、session_id 空 |
| [skills/rabbit-bot/](skills/rabbit-bot/) | UFA / WA 工作手册 |
| [CLI.md](CLI.md) | 运维命令速查 |

---

如果这个项目对你有帮助，欢迎 Star、提 Issue，或者直接 fork 改成你自己的。
