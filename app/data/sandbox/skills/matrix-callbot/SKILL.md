---
name: matrix-callbot
description: 要用电话把主人叫起来、给他播一段话、或者跟他在电话里对话时用（手机 Matrix 响铃）。
---

# 打电话给主人

主人手机上是 Element X，走 MatrixRTC + LiveKit。命令都在宿主：
`~/projects/matrix-callbot/callbot`（内部是 call.py，用那个目录的 venv 解释器）。

## 什么时候用

- 他说「打电话告诉我」「到了叫我」「有事打电话」
- 事情很急、他可能没看消息，且**这次通话本身是值得的**：
  消息能说清就别打；他开会、在公司、在外面的时候，打过去只会让他尴尬
- 他说「跟我打电话聊」时用 talk 模式

## 怎么做

```bash
CALL=~/projects/matrix-callbot/callbot
ROOM=!MDo3XMOhFH6jIU0azKbsdZFTbyrz0Xgi6eY3np6qJSs   # 他和鱼管家的私聊房间

$CALL ring  --room "$ROOM" --timeout 90            # 只响铃，他接了就算成功
$CALL say   --room "$ROOM" --text "该吃药了" --interval 4   # 响了之后循环播这句话
$CALL talk  --room "$ROOM"                          # 接通后双向对话（他说话 → 转写 → 回话）
$CALL state --room "$ROOM"                          # 谁正在通话里
```

读输出判断结果，不要猜：

- `· 接听了：…` = 他真的拿起手机了
- `· 对方挂断了` = 通话结束，程序自己收尾
- 跑到超时只有 `· 已挂断（清空 membership）` = 他没接

## 边界

- **只打给主人**（`@weikang:matrix.hollway.top`），房间就用他俩的私聊。
- 打之前先在聊天里说一句「我打电话给你」，让他知道来电是谁，不然显得可疑。
- 同一件事不要连打；他没接就等于没看到，隔一阵再说，别刷。
- `say` 的文本要短，一句话讲完一件事；`talk` 里他能听见你说话，别念稿。
- 这是要审批的命令，不是免审命令——别把 `callbot` 往严格白名单里塞。
- 不能改她的人设/记忆；这里只描述能力。

## 依赖坏了怎么办

- `say` / `talk` 需要本地 TTS 服务：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:12880/health`
  返回 401 是正常的（缺 token），返回 000 才是服务没起。
- `talk` 需要 whisper 模型，第一次跑会慢几十秒（要加载）；它已经预载在 call.py 里，振铃前就绪。
- 报 `HTTP 401`/`M_BAD_JSON` 之类，是 Matrix token 或 openid 过期，去看
  `~/projects/matrix-callbot/` 的日志与 `matrix-rtc-calls` 技能，不要自己改服务端配置。
