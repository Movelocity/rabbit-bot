# 飞书接入人工清单

这一步 Agent 代做不了，必须由有飞书管理员权限的人完成。做完把 App ID / App Secret 交给 Agent，**不要发到群里，也不要写进仓库**。

## 1. 建应用

1. 打开飞书开放平台（`open.feishu.cn`）→ 开发者后台 → 创建企业自建应用。
2. 应用必须是**独立应用**，不要复用别的服务（Hermes、旧机器人等）的 app。
   - 同一 app 两条长连接会互相抢事件，两边都不报错，表现是消息时有时无。
3. 拿到 `App ID` 和 `App Secret`。

## 2. 开启能力

- 添加「机器人」能力。
- 如果要在群里被 @：开启群聊相关能力。

## 3. 权限

至少：

- `im:message`
- `im:message.p2p_msg`（私聊消息）
- `im:message.group_at_msg`（群里 @ 机器人）

按需增加：

- `im:message.group_msg`（群里不 @ 也读消息；不申请就只能读 @）
- `im:chat:readonly`（读群信息）
- `contact:user.base:readonly`（读发送者名字）

## 4. 事件订阅

- 订阅 `im.message.receive_v1`（接收消息）。
- 订阅方式选**长连接**，不要配公网回调 URL。
- 需要表情回复时再订阅 `im.message.reaction.created_v1`。

## 5. 发布与可用范围

1. 创建版本并发布。
2. 可用范围至少包含要试聊的账号。
3. 未发布 / 未放范围时，事件不会到 rabbit-bot，日志里也看不到入站消息。

## 6. 交给 Agent 的只有两行

把下面两行写进 `~/.config/rabbit-bot/env`（权限 600），不要贴到聊天或任务文档：

```bash
FEISHU_APP_ID=<app id>
FEISHU_APP_SECRET=<app secret>
```

Agent 检查时只输出 `FEISHU_APP_ID set` / `missing`，不回显值。

## 7. Agent 侧继续

1. `config/local.json`：`adapters.feishu.enabled: true`，`adapters.matrix.enabled: false`，保留 `webChat.enabled: true` 作为备用出口。
2. `npm run build && pm2 restart rabbit-bot`。
3. `pm2 logs rabbit-bot --lines 120 --nostream`：
   - 期望看到飞书长连接建立。
   - 不应出现 `缺少环境变量`、`open_id cross app`、`app_id` / `app_secret` 无效。
4. 请人在飞书私聊里发第一条消息。**池由入站消息建立；没人发消息就不能主动发。**
5. 验证：

```bash
cd <repo>/app
TOKEN="${RABBIT_BOT_API_TOKEN:-$(cat data/run/api.token)}"
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3738/v1/pools
```

期望：出现 `platform: feishu` 的池，最近消息里有用户消息和机器人回复。

## 8. 常见人工错误

| 现象 | 先确认 |
|---|---|
| 日志无入站消息 | 应用发布了吗？可用范围包含该账号吗？事件选的是长连接吗？ |
| 私聊发消息没反应 | 权限有 `im:message.p2p_msg` 吗？是否有另一个服务用同一个 app？ |
| 群里 @ 没反应 | 有 `im:message.group_at_msg` 吗？机器人被拉进群了吗？ |
| 不能主动发第一条 | 正常。必须由人先发一条建立池。 |
| `open_id cross app` | 用了别的应用的 open_id；必须等本人先发消息，用本 app 的 open_id。 |
| 收到两条回复 | 同一 app 有两条长连接，或本机跑了两个 rabbit-bot 进程；见排障 D8。 |

## 9. 安全

- App Secret 等同密码，只放 env（600），不进仓库、不进日志、不进截图。
- 不要把 3738 直接暴露公网；先设 Web 密码、再走反向代理。
- 不需要群聊能力时不要申请 group 权限，缩小暴露面。
