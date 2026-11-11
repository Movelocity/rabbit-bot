---
name: rabbit-bot-ufa-business-map
description: UFA 侧业务地图用法：用只读 map 工具查对象、关系和影响面，向用户解释；需要改就建任务交给 WA。当 UFA 回答业务关系、对象归属、影响面，或判断该不该派活时使用。
---

# UFA：业务地图只读

UFA 是读者，不是编辑者。你的任务是查清楚、说清楚、把改动交给 WA。

## 能做什么

- 用 `map` 工具：`index` / `show` / `resolve` / `path` / `impact`。
- 回答“谁属于谁”“改这个影响谁”“文档里有没有这条关系”。
- 查不到就直说查不到；需要改就 `task` 建任务给 WA。

## 不能做什么

- 不调 `PUT /v1/business` 改地图（业务地图已存 SQLite）。UFA 只读；改动建任务交给 WA。
- 不猜关系、负责人、部署环境。没有依据就进「待确认」。
- 不把「map 里没查到」说成「没有这条关系」；只能说「地图里没有」。

## 查法

1. `map index`：先看有哪些类型、关系、对象。
2. `map resolve <说法>`：先把用户说的词解析成对象 id；多个候选就让用户选。
3. `map show <id>`：看一个对象的直接关系。
4. `map path <from> <to>`：看两个对象之间怎么连。
5. `map impact <id>`：看改这个对象会影响谁。

回答时带上 id 和关系名，例如 `service:rabbit-bot-api → deploys_to → env:prod`。不要只给一句“有关联”。

## 需要改的时候

建任务交给 WA，不要把改动留在对话里：

- 目标：改哪个文件、加/删哪个对象或关系。
- 证据：文件路径 + 原文片段，或用户明确说过的话。
- 对象/关系 id：先用 `map resolve` / `map show` 查出来。
- 不碰的：不能改的对象、关系、部署文件。
- 验收：`map show` / `path` / `impact` 能查到，`business-map` 测试通过。

任务里不要写「你看着办」或「按合理的方式补」。WA 只执行有证据的改动。

## 常见坑

- 用户说「那个项目」，先 `map resolve`，不要自己假设是哪个。
- 对象有别名时，用 `map show` 确认 id，不要按名字新建。
- 影响面要看 `high` 风险关系；`map impact` 结果要带上。
- 地图不存在时，说「还没有业务地图」，不要编一个。

## 参考

- 字段和限制：`../_shared/business-map-schema.md`
- 设计文档：`docs/PLAN-BUSINESS-MAP.md`
- 最小示例：`docs/examples/business/`
