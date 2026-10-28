# 提示词从代码里搬出来（模板化方案）

目标：像 `persona.md` 那样，提示词是**可编辑的文本文件**，不是 TS 字符串数组。
改一句话不该需要改代码、重新 `build`、重启进程。

## 现状

`app/src/agent/prompt.ts`（173 行 / 12.8k 字符）里三件事混在一起：

| 位置 | 内容 | 该去哪 |
|---|---|---|
| `systemPrompt()` L9-42 | 身份说明 + `[当前状态]` 块 + 12 条规则 | **模板** `config/prompt/system.md` |
| `wakePrompt()` L78-115 | 每轮唤醒的骨架（现在时间 / 计划 / 上下文 / 记忆 / 未读 / 潮汐状态） | **模板** `config/prompt/wake.md` |
| `wakeScript()` L129-169 | 三种唤醒场景的剧本 | **模板** `scene-message.md` / `scene-tick.md` / `scene-plan.md` |
| `HANDOFF_PROMPT` L171-173 | 交接要求 | **模板** `handoff.md` |
| `fmtMsg` / `poolLabel` / `fmtGrouped` / `fmtAgo` | 消息格式化 | 留在代码 |

## 目录

```
app/config/prompt/
  system.md            主提示词（人设用 {{persona}} 注入）
  wake.md              每轮骨架
  scene-message.md     有人说话时
  scene-tick.md        定时检查（含 {{proactive_block}}）
  scene-plan.md        计划到点
  handoff.md           交接文档要求
```

## 变量

模板用 `{{name}}` 占位，**没有条件、没有循环**——需要分支就在代码里选哪个模板，
需要列表就由代码拼成一段字符串整体注入。这样模板永远是纯文本，谁都能改。

`system.md`：
| 变量 | 来源 |
|---|---|
| `{{agent_name}}` | `cfg.agent.name` |
| `{{persona}}` | `loadPersona(cfg)` |
| `{{emoji_block}}` | 有表情时的「常用：…」整句；没有则空 |

`wake.md`：
| 变量 | 来源 |
|---|---|
| `{{now}}` | `fmtLocal(now)` |
| `{{wake_type}}` / `{{reasons}}` | `wake.type` / `wake.reasons` |
| `{{handoff_block}}` | 有交接文档时整段，否则空 |
| `{{plans_block}}` | 到点计划逐条拼好，否则空 |
| `{{context_block}}` | 近期上下文（按池分组） |
| `{{memories_block}}` | 可见记忆逐行 |
| `{{unread_block}}` | 未读消息，或「没有未读消息。」 |
| `{{tide_last}}` | 「上次主动：3 小时前（当时说的理由：…）」 |
| `{{tide_today}}` | 「今天已主动 0 条（…）」 |
| `{{scene}}` | 代码选定的场景模板渲染结果 |

`scene-tick.md`：
| 变量 | 来源 |
|---|---|
| `{{proactive_block}}` | 有水位档位时那段「【水位】…」，否则空 |

`scene-plan.md`：
| 变量 | 来源 |
|---|---|
| `{{plan_id}}` `{{plan_title}}` `{{plan_why}}` | 取 `plans[0]`；没写 why 时 `{{plan_why}}` 由代码给默认句 |

## 渲染器

`app/src/agent/template.ts`

```ts
/** 读模板 + 替换 {{var}}。缺变量直接抛错——静默留空会让提示词悄悄少一段。 */
export function render(name: string, vars: Record<string, string>): string;

/** 模板目录（可被 cfg.promptDir 覆盖，便于测试） */
export const TEMPLATE_DIR: string;
```

- 带 mtime 缓存：文件没变就不重复读盘（每轮都要渲染，不能每次都 `readFileSync` 上 MB）
- 缺变量抛错 + 列出缺了哪些；`console.warn` 里带上模板名
- 未使用的变量不报错（代码可以先传着，模板后加）

## 热更新语义（这点要说清楚）

| 模板 | 什么时候读 | 改了要重启吗 |
|---|---|---|
| `system.md` | **新建 pi 会话时**（`app.ts:83` 只算一次） | 要（或等 `freshNext` 新开会话） |
| `wake.md` / `scene-*.md` | **每轮唤醒** | 不用，下一轮就生效 |
| `handoff.md` | 上下文将满时 | 不用 |

和 Hermes 的 SOUL.md 不同（那边每轮重读、永远热），因为 pi 的 system prompt 是会话级固定的。
想改规则立刻生效 → 重启。这一点写进 `CLI.md` / `DEPLOY.local.md`，别再靠人记。

## 验收

1. `npm test` 全绿（现有 207 项，含 wake-script 的文案断言要改成读模板后断言）
2. 新增 `test/template.test.ts`：缺变量报错、mtime 缓存命中、变量替换正确
3. 迁移前后把 `systemPrompt()` 和 `wakePrompt()` 的输出做一次 `diff`（用同一份输入快照），
   **除空白外必须逐字一致**——模板化不该顺手改文案，文案改动单独一次提交
4. 改 `scene-tick.md` 里的一个字，重启后日志里的 prompt 跟着变（手工验一次）

## 顺序

1. 先写 `template.ts` + 测试（不动调用方）
2. 搬 `system.md`（最大块，先做，diff 最严）
3. 搬 `wake.md` + 三个 `scene-*.md`
4. 搬 `handoff.md`
5. 删 `prompt.ts` 里的字符串，只留格式化函数
6. 更新文档（`CLI.md` 加一节「改提示词」）

## 落地（2026-10-28 完成）

`prompt.ts` 从 12,788 字符降到 5,221：只剩 `fmtMsg` / `poolLabel` / `fmtGrouped` / `fmtAgo` 这些格式化函数，加上把数据拼成 block 的粘合代码。

9 个模板文件：`system.md`、`wake.md`、`scene-message.md`、`scene-tick.md`、`scene-plan.md`、`handoff.md`、`part-tide.md`、`part-proactive.md`、`part-plan-why.md`、`part-plan-nowhy.md`。

**逐字一致性已验证**：拿迁移前的 `prompt.ts`（`git show 56db001:app/src/agent/prompt.ts`）和新版对同一份输入渲染，8 个场景（message / message+交接 / tick / tick+水位 / plan 有理由 / plan 没理由 / systemPrompt 有表情 / 无表情）**非空白字符完全一致**。这保证了这次提交只动结构、没动文案。

**边界（务实取舍）**：结构性标签（`到点的计划：`、`未读消息：`、`记忆 xxx（在 p1 可见）：`）和循环仍在代码里——模板不支持循环，而这些标签跟数据形状绑死。规则、剧本、状态说明这些真正需要反复调的文案全在模板里。想连标签也搬出去，就得给模板加循环语法，那是另一种复杂度，目前不值得。
