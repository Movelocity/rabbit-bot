# 后台记忆梳理

> 状态：已实现，默认关闭。**后台自动只做记忆**；技能和业务关系走主动。
> 2026-11-11

## 目标

每 N 个用户回合，另起一个只带 `memory` 工具的临时会话，把最近对话里值得长期保留的事实整理出来。它不创建技能、不改业务地图、不发消息。

技能整理和业务关系检查是主动的：UFA 读 `skills/ufa-maintenance/SKILL.md` 后决定要不要做；业务异常用 `map` action=lint / `GET /v1/business/lint` 查看。

## 触发

- 每轮唤醒后累加未读里的用户消息数。
- `turns >= everyTurns` 且距上次超过 `minIntervalSec` 时触发。
- 还受暂停状态和日额度（token / 调用次数）限制。
- 先重置计数再执行，失败只记日志，不会每轮重试烧钱。

## 配置

放在专属运行时目录（默认 `~/.config/rabbit-bot/runtime/`）：

| 文件 | 内容 |
|---|---|
| `memory-review.json` | 设置：`enabled`、`everyTurns`、`minIntervalSec` |
| `memory-review-state.json` | 计数：`turns`、`lastReviewAt`、`lastOutcome` |

默认：

```json
{ "enabled": false, "everyTurns": 10, "minIntervalSec": 300 }
```

## 接口 / Web

```bash
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_BASE/v1/memory-review"

curl -s -X PUT "$RB_API_BASE/v1/memory-review" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"enabled":true,"everyTurns":10,"minIntervalSec":300}'
```

Web：`管理 → 调度 → 后台记忆梳理`，可开关、调回合数和最小间隔。

## 后台会话

- 独立临时会话，不落盘、不污染主对话。
- 工具只有 `memory`：不能发消息、建任务、建技能、改业务地图。
- system prompt：`prompts/memory-review-system.md`；用户提示：`prompts/memory-review.md`。
- 记忆规则沿用正常写入：带日期/名字，改口用 `supersede`，不再成立用 `expire`，来源 seq 自动绑定。

## 主动部分（不在后台）

- 技能：UFA 读 `skills/ufa-maintenance/SKILL.md`；要新建/修改技能，建任务给 WA（UFA 不直接写文件）。
- 业务关系：UFA 用 `map` 的 `lint/show/resolve/path/impact` 查；要改就建任务给 WA，不直接 `PUT`。
