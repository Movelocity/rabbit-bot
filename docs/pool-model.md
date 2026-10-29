# Pool（会话模型）

只有一个实体：**pool**。一条消息流 + 一组参与者。两方还是多方，是**成员数量**，不是类型。

曾经想分出 stack（两方通信）和 room（多房间），最后收掉了。原因是包含关系会逼出写时扇出：
room 每发一句就要往它下面每条 stack 叠一份，各 stack 的 seq 还会错开，得靠消息 id 重新对齐。
一旦**平级**，room 自己就是一条流，扇出问题直接消失——没有包含，就没有分发。

## 现状

```sql
pools(pool_id TEXT PK, platform, external_id, kind, title, created_at, last_msg_at)
UNIQUE(platform, external_id)
```

- `external_id` —— 这条流绑在哪个 IM 会话上。为空 = 纯本地流，只落库，不出池。
- `kind` —— 目前有 dm / group，**只用于展示**，没有任何逻辑分支依赖它。
- `messages.internal` —— 已经是「不出池、不进上下文」的开关，语义不用新开字段。

## 「两方」假设在哪

它没写在类型里，是散在五个地方：

| 位置 | 隐含假设 | 多方会怎样 |
|---|---|---|
| `messages.from_self` | 布尔：我说的 / 他说的 | 第三个实体无法表达 |
| `cursors(pool_id PK)` | 一个池只有一个读者 | 多成员互相覆盖读位（**结构断点**） |
| `messages.is_mention_me` | "me" 就是 agent | 房里 @ 别人也算 @ 我 |
| `core/hub.ts` `send()` | 按 `pool.platform` 找 adapter | 不依赖人数，依赖「有没有外部绑定」 |
| `config/prompt/*.md` | 人称只有「他 / 我」 | 多人时要写清是谁 |

前两条是结构性的，第三条加参数，第四条是语义纠偏，第五条只是文案。**没有一条要新增表。**

## 从两方到多方，最小动作

1. `cursors` 主键改成 `(pool_id, reader_id)`
2. `from_self` 退场，一律看 `sender_id`（`user:xxx` / `agent:xxx` / `inject:xxx`）
3. `is_mention_me` 改成 `mentions` + 读者身份判定
4. `hub.send` 的前置条件从 `platform` 改成 `external_id IS NOT NULL`

成员表（`pool_members`）暂时不需要：谁在这个池里说过话，从 `messages.sender_id` 就能推。
只有真要「加人 / 踢人 / 权限」时才建。

## 不做的事

- 不做 room 表，不做 stack 表——都是 pool 的变体，词表只留一个词
- 不做写时扇出（同一句话存 N 份）
- 不做「stack 往 IM 转发 room 消息」——转发是池的属性，不是层级关系
