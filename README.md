<div align="center">

<h1>rabbit-bot</h1>

<p><strong>不是一问一答的聊天机器人，而是一个会等、会挑时机、会自己干活的 IM Agent。</strong></p>

<p>接上飞书或 Matrix，它住进你的聊天里。消息先进「聊天池」，调度器决定何时叫醒模型，其余全是确定性代码。</p>

<p>
  <a href="https://nodejs.org"><img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7.x-3178C6?logo=typescript&logoColor=white"></a>
  <a href="https://sqlite.org"><img alt="SQLite" src="https://img.shields.io/badge/SQLite-local-003B57?logo=sqlite&logoColor=white"></a>
  <a href="https://pi.dev"><img alt="pi" src="https://img.shields.io/badge/engine-pi-111111"></a>
  <img alt="IM" src="https://img.shields.io/badge/IM-Feishu%20%7C%20Matrix-00A3FF">
</p>

</div>

> Companion bot for IM integration — proactive when it has a reason, silent when it doesn't.

---

## 为什么不是又一个 Chatbot

普通 Bot 的循环是「收到消息 → 调模型 → 回一句」。代价是每条消息都在烧 token，群聊一热闹就刷屏，模型还得假装自己记得上下文。

| 普通 IM Bot | rabbit-bot |
|---|---|
| 每条消息都触发一次 LLM | 有未读、有日程、被 @，才叫醒模型 |
| 回复越快越好 | 该沉默时沉默，该接话时接话 |
| 上下文靠聊天记录硬塞 | 池子就是上下文，游标精确到「读到哪」 |
| 一个平台一套逻辑 | 飞书 / Matrix 共用一套池与调度 |
| 说过什么只有日志知道 | 读池、工具调用、发送全程可审计 |

## 核心特性

| 能力 | 说明 |
|---|---|
| **聊天池** | 每个私聊 / 群 / 房间是一个池。Agent 一次读多个池，不重复、不遗漏 |
| **确定性调度** | tick 批量处理、私聊去抖、群聊被 @ 立即响应、日程到点唤醒；单实例 FIFO，天然不并发抢话 |
| **只在必要时烧 token** | 无未读不唤醒；活跃期自动缩短 tick，静默后恢复；日调用 / token / 花费三道上限 |
| **多 IM 插件** | 飞书、Matrix、mock 共用一套池与调度。新增平台只需实现 `IMAdapter` |
| **像个人在聊** | 人设、说话规则、主动开口、防客服腔、防复读；群里没 @ 也能自己判断要不要接话 |
| **可管可控** | 出站审核、命令审批、任务发布审批；全局暂停；每次唤醒都有完整日志 |
| **会干活** | 聊天和交付分开：UFA 负责聊，WA 在独立进程里跑任务、回传进度和产出 |
| **本地优先** | SQLite + 本地 Web 管理台；数据、会话、日志都在自己机器上，不依赖外部 SaaS |

## 一条消息的旅程

```
飞书 / Matrix ──→ 聊天池(SQLite) ──→ 调度器 ──→ 单实例队列 ──→ pi Agent
                                      ↑                              │
                         tick / 私聊去抖 / 群@ / 日程                 │
                                      └────── send(pool, text) ←─────┘
```

没轮到它，就不烧 token；轮到它，也只读该读的未读和近期上下文。

## 30 秒体验

不需要 API Key，不需要 IM 账号，不需要 Docker：

```bash
cd app
npm install
npm run demo
```

mock 适配器 + 桩 LLM 会走完整管线：入池、去抖、唤醒、工具调用、发送、日志。

想接真实飞书 / Matrix，看 [app/README.md](app/README.md) 的部署章节。

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
| [app/README.md](app/README.md) | 部署、配置、Web 管理台、任务模型 |
| [app/DEPLOY.local.md](app/DEPLOY.local.md) | 本机部署事实与升级清单 |
| [docs/](docs/) | 架构、记忆、主动开口、沙盒、业务地图等设计文档 |
| [skills/rabbit-bot/](skills/rabbit-bot/) | 项目级技能组：UFA / WA 的工作手册 |
| [CLI.md](CLI.md) | 运维命令速查 |

---

如果这个项目对你有帮助，欢迎 Star、提 Issue，或者直接 fork 改成你自己的。
