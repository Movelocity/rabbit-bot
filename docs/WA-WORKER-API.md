# WA 任务执行契约

WA（working agent）不需要是本仓库的一部分，也**不需要常驻轮询**。

现在的模型是：**每个任务一个一次性进程**。

1. UFA 建任务时给一个工作目录（`work_dir`，绝对路径）；
2. 系统在 `<work_dir>/.ufa/tasks/task-<id>.md` 写一份任务文档；
3. 系统用 `opencode run` 或 `mimo run` 在 `<work_dir>` 里拉起一个一次性进程，并把 session id 记下来；
4. 进程按任务文档干活，通过回环 API 报进度、完成、失败、申请权限；
5. 需要继续之前的会话时，用同一个 session id（`-s <session_id>`）再启动一次。

外部 WA 只要能按下面的契约回传，就可以用你自己的执行器，不必是本系统。

## 环境变量

子进程会拿到：

| 变量 | 含义 |
| --- | --- |
| `RB_API_BASE` | 回环 API 根地址，例如 `http://127.0.0.1:3738` |
| `RB_API_TOKEN` | Bearer token |

**token 只从环境变量读，不要写进任务文档、脚本、日志或 shell 历史。**

## 任务文档模板

系统在 `<work_dir>/.ufa/tasks/task-<id>.md` 写入的内容大致是：

```markdown
# 任务 #12

## 目标
整理会议纪要

## 产出物
notes.md

## 约束
只读输入文件

## 验收
notes.md 里有结论和待办

## 关联文件
- meeting.md

## 工作目录
`/abs/path/to/project`

## 任务 id
12

## 如何更新任务

所有请求都带 `Authorization: Bearer $RB_API_TOKEN`，接口根地址用 `$RB_API_BASE`。

### 1. 先报一次进度（开始执行时）
curl -s -X POST "$RB_API_BASE/v1/tasks/12/progress" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"worker_id":"opencode-12","stage":"working","note":"开始执行"}'

### 2. 完成
curl -s -X POST "$RB_API_BASE/v1/tasks/12/complete" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"worker_id":"opencode-12","result":"写清楚做了什么、结果如何","artifact":"产出物路径或链接"}'

### 3. 失败
curl -s -X POST "$RB_API_BASE/v1/tasks/12/fail" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"worker_id":"opencode-12","error":"失败原因","retryable":false}'

### 4. 权限申请
curl -s -X POST "$RB_API_BASE/v1/approvals" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task_id":12,"worker_id":"opencode-12","action":"要做的事","detail":"路径或参数","why":"为什么需要"}'

curl -s "$RB_API_BASE/v1/approvals/<审批id>" \
  -H "Authorization: Bearer $RB_API_TOKEN"

## 执行要求
- 开始执行时先调用一次 progress，stage=working。
- 完成或失败必须回传：调用 complete 或 fail。
- 不要编结果，不要改工作目录之外的文件。
```

`worker_id` 固定为 `<executor>-<task_id>`，例如 `opencode-12`、`mimo-12`。

## 回环 API

- 地址：`http://127.0.0.1:3738`（回环，不要暴露到公网）
- 鉴权：所有 `/v1/*` 请求都要带 `Authorization: Bearer $RB_API_TOKEN`
- 返回体固定：`{"ok":true,"data":…}` / `{"ok":false,"error":"…"}`
- 状态码：400 参数/状态不对，401 token 不对，404 任务/审批不存在，409 任务已在运行 / 没有 session / 不匹配

token 的获取方式见 `app/docs/sandbox-api.md`：默认在 `data/run/api.token`，也可以用 `RABBIT_BOT_API_TOKEN` 覆盖。

### 建任务

```bash
curl -s -X POST "$RB_API_BASE/v1/tasks" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "u1",
    "pool_id": "feishu:oc_xxx",
    "goal": "整理会议纪要",
    "work_dir": "/abs/path/to/project",
    "executor": "opencode",
    "model": "provider/model",
    "dispatch": true
  }'
```

- `work_dir` 必填，必须是**已存在的绝对路径**
- `executor` 是 `opencode`（默认）或 `mimo`
- `model` 可空，空 = 执行器默认模型
- `dispatch` 默认 `true`：建完立刻写任务文档并启动一次性进程；`false` 只登记
- 返回的任务里带 `work_dir` / `executor` / `model` / `session_id` / `runner_pid` / `doc_path`

### 管理单个任务

```bash
# 新起一个会话执行（会清掉旧 session）
curl -s -X POST "$RB_API_BASE/v1/tasks/12/start" \
  -H "Authorization: Bearer $RB_API_TOKEN"

# 用已有 session id 恢复
curl -s -X POST "$RB_API_BASE/v1/tasks/12/resume" \
  -H "Authorization: Bearer $RB_API_TOKEN"

# 停掉在跑的进程（只清理 runner，不置 cancelled）
curl -s -X POST "$RB_API_BASE/v1/tasks/12/stop" \
  -H "Authorization: Bearer $RB_API_TOKEN"

# 取消（在跑的话先杀进程，再置 cancelled）
curl -s -X POST "$RB_API_BASE/v1/tasks/12/cancel" \
  -H "Authorization: Bearer $RB_API_TOKEN"
```

`start` / `resume` 在任务已经在跑时返回 409；`resume` 没有 `session_id` 也返回 409。

### 报进度

```bash
curl -s -X POST "$RB_API_BASE/v1/tasks/12/progress" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"worker_id":"opencode-12","stage":"fetch","note":"正在拉取数据"}'
```

- `stage` 必填；同一条任务只有当前 `worker_id` 能报
- 进度会写进任务池，UFA 用 `task updates` 能按时间戳看到

### 完成 / 失败

成功：

```bash
curl -s -X POST "$RB_API_BASE/v1/tasks/12/complete" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"worker_id":"opencode-12","result":"报告写好了","artifact":"/work/report.md","note":"已验收"}'
```

失败：

```bash
curl -s -X POST "$RB_API_BASE/v1/tasks/12/fail" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"worker_id":"opencode-12","error":"网络超时","retryable":false}'
```

- `retryable=false`：任务落 `failed`，写 `result` / `note` / `end_at`
- `retryable=true`：任务回 `pending`，清空归属，可以重新 start
- 两种情况都会在任务池里留一条带时间戳的事件

### 权限申请

创建申请（`task_id` 指向正在执行的任务）：

```bash
curl -s -X POST "$RB_API_BASE/v1/approvals" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task_id":12,"worker_id":"opencode-12","action":"shell: npm publish","detail":"/work","why":"发布产物","timeout_s":600}'
```

轮询结果：

```bash
curl -s "$RB_API_BASE/v1/approvals/34" \
  -H "Authorization: Bearer $RB_API_TOKEN"
```

```bash
curl -s "$RB_API_BASE/v1/approvals?status=pending&task_id=12" \
  -H "Authorization: Bearer $RB_API_TOKEN"
```

- `status`：`pending` / `approved` / `rejected` / `timeout`
- 只有 `pending` 能被裁决；超时按拒绝处理（fail-closed）
- `approved` 才继续；`rejected` / `timeout` 立即停下，用 `fail` 回传

### 查看任务与事件

```bash
curl -s "$RB_API_BASE/v1/tasks/12" \
  -H "Authorization: Bearer $RB_API_TOKEN"

curl -s "$RB_API_BASE/v1/tasks/12/snapshot" \
  -H "Authorization: Bearer $RB_API_TOKEN"

curl -s "$RB_API_BASE/v1/tasks/12/events?limit=20" \
  -H "Authorization: Bearer $RB_API_TOKEN"
```

任务池是只读时间线：WA 通过上面的动作写事件，不直接写消息接口。

## 恢复执行：用同一个 session id

`resume` 接口会带着任务里保存的 `session_id` 启动。手工执行时等价于：

opencode：

```bash
opencode run "继续任务，先读 /abs/path/to/project/.ufa/tasks/task-12.md" \
  -s ses_xxxxxxxx \
  --dir /abs/path/to/project \
  --title "WA-task-12" \
  --format json
```

mimo：

```bash
/Users/viking/.mimocode/bin/mimo run "继续任务，先读 /abs/path/to/project/.ufa/tasks/task-12.md" \
  -s ses_xxxxxxxx \
  --dir /abs/path/to/project \
  --title "WA-task-12" \
  --format json
```

新任务不要带 `-s`；只有恢复才带。

## 进程与日志

- 每条任务用 `detached` 方式起一个一次性进程，不常驻、不轮询；
- `runner_pid` / `runner_started_at` 记录当前进程，`session_id` 记录执行器会话；
- stdout/stderr 落到 `data/tasks/<task_id>/runner.jsonl`；
- 3 秒内从事件流抓到 `sessionID` 就写回任务；抓不到也会保存 pid，并在 `runner.jsonl` 里留一行说明；
- `stop` / `cancel` 会杀整个进程组（TERM → 5 秒 → KILL）。

## 最小流程

```
建任务（work_dir + goal，dispatch=true）
  → 系统写任务文档并起一次性进程
  → 进程先 POST progress (stage=working)
  → 需要权限时 POST approvals，轮询到 approved / rejected / timeout
  → POST complete 或 fail 回传终态
  → 需要继续上一会话时 POST resume（内部用 -s <session_id>）
```
