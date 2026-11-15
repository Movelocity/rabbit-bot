# 排查手册：执行器与任务审批

这两条链路最容易「看起来配好了、其实一声不响」。症状都是**没有报错**，
所以先按这张表对症状，再去看对应的那一节。

| 症状 | 跳到 |
|---|---|
| 建了任务，Matrix / 飞书**一条审批提示都没收到** | [§1](#1-任务建了但一条审批提示都没发) |
| 审批提示收到了，点了 OK 却没开始执行 | [§2](#2-提示收到了点-ok-却不执行) |
| 任务瞬间失败，`runner.jsonl` 里 `ms` 只有几十 | [§3](#3-执行器秒退几十毫秒-code1) |
| 能跑，但 `session_id` 是空的，恢复（`-s`）用不了 | [§4](#4-session_id-落库为空恢复用不了) |
| 审计备注写着「飞书审批通过」，实际是在 Matrix 批的 | [§5](#5-备注里的平台名和事实不符) |

排查永远从这三个地方看，别先猜：

```bash
# 1) 这次执行的原始 argv、退出码、session 抓没抓到
cat app/data/tasks/<id>/runner.jsonl

# 2) 任务状态与被写入的元数据
sqlite3 app/data/rabbit-bot.db \
  "select id,status,session_id,runner_pid,substr(note,1,80) from tasks order by id desc limit 5;"

# 3) 进程自己说的话
tail -50 app/logs/pm2.out.log     # 运行期日志（审批、唤醒、API）
tail -50 app/logs/pm2.err.log     # 崩溃栈
```

---

## 1. 任务建了但一条审批提示都没发

**根因几乎总是配置：`taskApproval` 段不存在。**

配置里有**两个长得很像的开关**，作用完全不同：

| 配置段 | 管什么 |
|---|---|
| `approval` | 工具/操作审批（沙盒里跑命令前弹的那道闸） |
| `taskApproval` | **任务发布审批**（UFA/API 建任务后发提示让人贴 OK） |
| `sendReview` | 外发消息审核 + **主聊天（`primaryPoolId`）的定义** |

`taskApproval.enabled` 的默认值是 **`false`**（`config/default.json`），所以只写 `approval`
不会让任务审批生效。而且这道闸是**静默**的：`agent/tools.ts` 里

```ts
if (gate?.enabled) { /* 发提示 */ }
// 否则只回一句「等待 Web 审批」
```

`gate.enabled = cfg.enabled && ownerIds.length > 0`（`core/task-approval.ts`）。
`ownerIds` 为空同样等于关。

**最小可用配置**（`app/config/local.json`）：

```json
{
  "taskApproval": {
    "enabled": true,
    "platform": "matrix",
    "roomId": "!你的主聊天房间ID",
    "ownerIds": ["@你:matrix.你的域名"],
    "timeoutMs": 86400000,
    "notify": true
  }
}
```

**发到哪儿**由 `resolveTaskApprovalTarget()` 决定：先看 `sendReview.primaryPoolId`
（主聊天，管理台的「主对话」设置写的运行时文件 `data/run/send-review.json` 也算），
拿不到才退回上面的 `taskApproval.roomId`。所以**任务从群聊发起也会发到主聊天**，
不会把审批提示漏进项目群——这是有意的，别改回去。

飞书就相应换成 `"platform": "feishu"` + 飞书 chat id。

**验收**：建一条 `pending_approval` 任务，日志里应出现

```
任务 #N「标题」已发到 matrix:!xxx，等主人裁决
```

这行是**发送成功之后**才打的（`core/task-approval.ts` 里 `r.ok` 才 info），
看到它就说明消息真的出去了，不是排队中。

---

## 2. 提示收到了，点 OK 却不执行

看日志里那一行裁决记录：

```
任务 #N 审批 approved by @xxx（21713ms）
```

- **有这行、状态仍是 `pending_approval`** → 批准后 `startTask()` 失败，看紧跟着的
  `任务 #N 启动失败` / 执行器相关报错。
- **没这行** → 你的回复没进审批闸。三个常见原因：账号不在 `ownerIds`（只认精确 MXID）、
  消息不是对审批提示的**回复**（闸只认回复链）、超过 `timeoutMs`（默认 24h，超时按拒绝处理）。

审批闸和「聊天回复」共用同一条入站队列，所以**一次只测一条**：
同时点 OK 又在后台调 `/v1/tasks/:id/cancel`，会撞成「approved 但状态 cancelled」，
排查时先确认没有别的进程/脚本也在改这条任务。

---

## 3. 执行器秒退（几十毫秒、code=1）

先看 `runner.jsonl` 第一条里的 `argv`，再拿它对**本机这个版本**的 CLI 逐字核。
这类失败 100% 是参数名对不上，日志原文会给一句
`ERROR: Unrecognized flag: --dir in command opencode run`。

已踩过的坑（opencode）：

| 写法 | 结果 |
|---|---|
| `opencode run "..." --dir <路径>` | ❌ v2 没有 `--dir` |
| `opencode run "..." --directory <路径>` | ❌ 同样不认，它只认子命令**之前**的全局位置 |
| `opencode --directory <路径> run "..."` | ✅ 但没必要——`spawn({cwd})` 已经把工作目录定死 |
| `opencode run "..." --dangerously-skip-permissions` | ✅ v2 仍认，等价 `--auto` / `--yolo` |
| `opencode run "..." --title X --format json` | ✅ |

**判断某个 flag 是否被接受，不要用 `--help`。** `--help` 会短路参数解析：

```bash
opencode run --bogus-flag --help   # 照样打印帮助，看不出问题
opencode run --bogus-flag ""       # 立刻 Unrecognized flag ← 这才是探针
opencode run --auto ""             # "You must provide a message" ＝ flag 被接受
```

最后一条技巧：给**空消息**能让被接受的 flag 走到「缺消息」这个错误就停下，
不会真的调模型，探测零成本。

**工作目录不要靠参数传**：`launch()` 用 `spawn(bin, args, {cwd: workDir})`，
CLI 以当前目录为项目根。加了目录参数只会多一个版本兼容问题。

---

## 4. `session_id` 落库为空、恢复用不了

症状：任务能跑、模型也回了，但

```bash
sqlite3 app/data/rabbit-bot.db "select id,session_id,note from tasks;"
# 3||开始执行
```

恢复时报「任务 #3 没有 session_id，不能恢复」。

**根因是时序**：`session_id` 从执行器的 stdout 事件流里抓（`--format json` 第一条带
`sessionID` 的行）。`DEFAULT_CAPTURE_MS` 曾经是 3000ms，而 opencode 冷启动到第一个事件
实测 **3444ms**——窗口先超时、数据库先写成空串，之后流里再出现 `ses_...` 也没人落库。

**修法（已在代码里）**：抓到的那一刻就 `updateTask` 落库，不再等窗口结束；默认窗口 15s。
`runner.jsonl` 里的这行只说明「窗口内没抓到」，**不再代表彻底丢了**：

```json
{"type":"ufa-dispatch","note":"15000ms 内未从事件流抓到 sessionID（pid=…）"}
```

**你自己的执行器接入时要注意两点**：
1. 事件流第一行必须带稳定字段（本项目认 `sessionID` / `session_id` / `sessionId`，含 `part.*` 里的）；
2. 冷启动慢的执行器，别把捕获窗口设得比首个事件还短——宁可直接落库两次，也不要只落一次。

**验收（三件套，能一次跑完）**：

| 任务 | 验什么 | 通过标准 |
|---|---|---|
| A：`dispatch:true` 建一条「只回一句话」 | argv 正确、能跑通 | `runner.jsonl` 的 `argv` 无多余参数；`code=0` |
| B：同 A，跑完看库 | session 抓取 | `tasks.session_id` 非空 |
| C：`POST /v1/tasks/<id>/resume` | 恢复链路 | 新的 argv 带 `-s <session_id>`，跑完仍是 `done` |

---

## 5. 备注里的平台名和事实不符

`tasks.note` 是审计轨迹。曾经写死 `飞书审批通过（by=…）`，于是 Matrix 上批的也记成飞书。
现在按 `taskApproval.platform` 出标签：`matrix` → `Matrix`，其余 → `飞书`。
改文案时**不要写平台名常量**，从配置取。

---

## 附：改动这一类代码的检查清单

- [ ] `agent/tools.ts` 的提示语（「等待 Web 审批」/「已发审批提示」）与实际行为一致
- [ ] `resolveTaskApprovalTarget()` 改动后，主聊天和固定审批房两条退路都还通
- [ ] 参数改动同时改 `test/dispatch.test.ts` 里对 argv 的断言——
      **断言「不该带某个参数」比断言「带了某个参数」更能防回归**
- [ ] `npm run build && npm test` 全绿（当前 638 条）
- [ ] 真机跑一轮上面的三件套，别只看单测
