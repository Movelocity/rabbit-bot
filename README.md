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
| [docs/](docs/) | 架构、记忆、主动开口、沙盒、业务地图 |
| [skills/rabbit-bot/](skills/rabbit-bot/) | UFA / WA 工作手册 |
| [CLI.md](CLI.md) | 运维命令速查 |

---

如果这个项目对你有帮助，欢迎 Star、提 Issue，或者直接 fork 改成你自己的。
