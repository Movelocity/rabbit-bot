# 项目体检报告与修复需求（2026-11-26）

> 起因：见 `docs/TROUBLESHOOT-wake-abort.md`（turn-timeout 中止后交接，消息已读未回）。
> 本文是只读审计的结论 + 给后续开发的**改动需求与验收方式**。代码未改动。
> 行号基于 2026-11-26 工作区（含未提交的 abort 回滚/重试改动），实施前请先重新定位。
> 标注：【已核实】= 人工读代码/查线上数据确认；【待核实】= 审计子代理读代码得出，实施前先复核。

## 实施进度（2026-11-26）

PR1 已完成（P0-A + B1/B2/B4，含测试）：

- A1 ✅ 硬超时 + 宽限期；abort signal 贯通审批与命令执行。host 模式杀进程组；docker 模式只能杀 `docker exec` CLI，容器内进程仍由 timeout 兜底（已知缺口）。
- A2 ✅ 中止/报错不写交接；交接改用独立 `handoff.timeoutMs`（默认 90s）。
- A3 ✅ 交接与 wake_log 的 assistantText 只取本轮新消息，不再把上一轮回复当交接。
- A4 ✅ handoff 主体 `try/finally`，写文件/落库失败也必定 dispose 并重置会话。
- A5 ✅ 上下文溢出错误直接换新会话，不写交接。
- A6 ✅ `engine.run` 抛异常时回滚游标、还原交接、记 wake_log error。
- B1 ✅ 发送成功统一按 `details.ok === true` 判定。
- B2 ✅ 任务转述把 `res.aborted` 纳入失败判定，0 发送不推进游标。
- B4 ✅ 401/402/403/额度等不可重试：回滚 + 5 分钟冷却 + 提示；429/5xx/网络按 0/1/5 分钟退避，最多 3 次。
- B6 ⚠️ 已做一半：本轮回滚时跳过 `noteInboundMessages` / `maybeMemoryReview`；重复计数场景未单独验证。

验证：`npm run typecheck`、`npm test`（800/800）、`npm run build` 通过。

仍待处理：A1 docker 模式强杀容器内进程；B3/B5/B7/B8/B9；C1/C2/C3；D1–D5；P2。重试账本（`abortRetries` / `llmRetries`）仍在内存，进程重启会丢，属 B9 范围。

## 0. 现状快照

- `npm test` 788/788 通过；`npm run typecheck`、`npm run web:typecheck` 通过。
- pm2 `rabbit-bot` restart 计数 142（未区分主动部署与崩溃，建议查 `pm2 logs --err`）。
- wake_log 趋势（非 skipped）：11-24 前平均耗时 7–25s；11-24 起 60–69s，3 天内 4 次 `aborted:turn-timeout`（336s / **726s** / 300s / 353s）。
- 11-25 21:34–21:38：OpenRouter 403「Key limit exceeded」连续 **18 次**回滚重试（约每 15s 一次），会话上下文每次 +~376 tokens。另有 44 条 `error:task-relay` 同因。
- 相关配置（`app/config/default.json`）：`turnTimeoutMs=300000`、`handoff.contextTokenLimit=100000`、`sessionTokenLimit=600000`、`exec.maxReadChars=8000`、`exec.maxFileBytes=262144`；`local.json` 中 `approval.timeoutMs=600000`、shell `mode=docker`。

快速复查命令（在 `app/` 下）：

```bash
sqlite3 data/rabbit-bot.db "select date(ts/1000,'unixepoch','localtime') d, json_extract(json,'$.outcome') o, count(*), round(avg(json_extract(json,'$.ms'))/1000) from wake_log where ts > (strftime('%s','now','-14 days')*1000) and o not like 'skipped%' group by d,o order by d,o"
```

---

## P0-A 交接 / 中止链路（`app/src/agent/engine.ts`）

### A1 turn-timeout 不是硬上限【已核实：726s 实例】 ✅
- 位置：`engine.ts:243`（`abort()` 只调 `s.abort()`）、`:284`（timer）、`:286`（`await s.prompt` 无竞速）。自定义工具 `execute` 均不接 abort signal（`grep signal app/src/agent/` 无结果）。
- 场景：shell 命令或宿主审批（`tools.ts` 中 `d.approval.request`，最长 600s）在跑时超时触发，prompt 仍要等工具返回；单 runner 队列被整体阻塞，`App.stop()` 也会挂住。
- 需求：
  1. `runPrompt` 用 `Promise.race([s.prompt(...), abortDeadline + graceMs])`，宽限期（如 15s）后强制返回 `aborted:turn-timeout`，并标记该会话为「脏」（下一轮新建会话）。
  2. 把 abort signal 传入 `approval.request` 与 `execShell`/`runShell`，触发时取消审批、杀进程组。
  3. 配置校验：`approval.timeoutMs` 必须 < `turnTimeoutMs`，否则启动告警或自动取较小值。
- 验收：测试中用一个永不返回的假工具 + 小 `turnTimeoutMs`，断言 `run()` 在 timeout+grace 内返回且 `abortReason==="turn-timeout"`；审批等待中超时，断言审批被取消、命令未执行。

### A2 被中止的会话仍做交接，且交接拿到第二个完整超时【已核实】 ✅
- 位置：`engine.ts:209`（条件只排除 `res.error`，不排除 `aborted`）、`handoff()` 内 `runPrompt` 重新起 `turnTimeoutMs` 计时。
- 需求：
  1. `res.aborted`（尤其 `turn-timeout`）时**不写交接笔记**：直接 dispose 会话、`freshNext=true`、`seenPools.clear()`，沿用 `latestUnconsumedHandoff()` 作为 pending。
  2. 交接 `runPrompt` 使用独立的短超时（新增配置如 `handoff.timeoutMs`，默认 90s）。
  3. 参考 DS-Bot：交接只在「一轮干净结束」后做；交接失败且未超硬线时保留旧会话、按 60s/300s/900s 退避再试；超硬线才放弃笔记直接换。
- 验收：模拟 turn-timeout + 上下文超限，断言不调用交接 prompt、会话已重置、总耗时 ≈ 一个 timeout。

### A3 交接被中止时可能把上一条聊天回复存成交接文档【待核实】 ✅
- 位置：`engine.ts:306`（`s.getLastAssistantText()`）、`:314`。pi 的 `getLastAssistantText()` 会跳过空的 aborted assistant 消息往前找。
- 需求：prompt 前记 `const n0 = s.messages.length`，只从 `s.messages.slice(n0)` 中取 assistant 文本；`r.aborted && 无新文本` 视为空交接。同样修正 wake_log 的 `assistantText`。
- 验收：构造会话「上一轮有回复 → 交接 prompt 立即 abort」，断言不写 handoff、不把旧回复当交接。

### A4 交接抛异常后会话工具被清空且不释放【已核实代码路径】 ✅
- 位置：`engine.ts:312-318`，`s.setActiveToolsByName([])` 之后 `writeFileSync`/`addHandoff` 抛错 → `s.dispose()`、`this.session=null` 不执行。之后每轮都在零工具会话里跑，永远发不出消息。
- 需求：`handoff()` 主体包 `try/finally`，finally 中必定 dispose + `session=null` + `freshNext=true` + `seenPools.clear()`。
- 验收：mock `fs.writeFileSync` 抛错，断言下一次 `run()` 新建会话且工具齐全。

### A5 报错时不做交接，上下文溢出死循环【已核实代码路径】 ✅
- 位置：`engine.ts:209` `!res.error` 条件；`app.ts` error 分支回滚游标后下一 tick 在同一会话重试。
- 需求：`res.error` 且（`ctxTokens >= contextTokenLimit` 或错误文本匹配 context length / too large / 413）时，直接丢弃会话换新（不写笔记），参考 DS-Bot「溢出错误直接 switch + resume」。
- 验收：mock LLM 返回 context-length 错误，断言下一轮使用新会话。

### A6 `engine.run` 抛异常：游标、交接、用量全丢【已核实代码路径】 ✅
- 位置：`app.ts:1126`（`takePendingHandoff()` 已在 DB 标 consumed）、`:1164`（`engine.run` 无 try）。
- 需求：`handleWakeInner` 中包住 `engine.run`：catch 时回滚 `cursorsBefore`、把交接还原为未消费（新增 `store.unconsumeHandoff(id)` 或延迟到成功后再标 consumed）、按 error 路径处理并记 wake_log。
- 验收：mock `ensureSession` 抛错，断言游标回到原值、handoff `consumed=0`、wake_log 有 `error` 记录。

---

## P0-B 已读未回 / 丢消息（`app/src/app.ts` 等）

### B1 发送失败被算作「已发送」【已核实】 ✅
- 位置：`app.ts:1171` `sent = toolCalls.filter(send && !c.isError)`；`tools.ts:242-262` 中被压住（held）、发送失败、风格闸拦截都返回 `txt(..., {ok:false})`，`isError=false`。
- 后果：中止/报错时 `sent.length>0`，不回滚、不提示、还清空重试账本。
- 需求：成功判定改为 `details.ok === true`（含 `queuedForReview`），与 `relayTaskUpdates`（`app.ts:~1007`）口径一致；抽成共用函数。
- 验收：模拟一轮「send 被 held → turn-timeout」，断言游标回滚并重排唤醒。

### B2 任务转发被中止也记为已转发【待核实】 ✅
- 位置：`app.ts:~1011`，条件 `!delivered.length && (res.error || undelivered>0)` 不含 `res.aborted`。
- 需求：加入 `res.aborted`，中止时不推进任务池游标与 `TASK_RELAY_CURSOR_KEY`。
- 验收：任务转发轮 turn-timeout 且 0 发送，断言游标/KV 未推进。

### B3 一轮中途读到的池子不回滚【待核实】
- 位置：`app.ts:1111` `cursorsBefore` 只含开始时有未读的池；`hub.send` 内部 `takeUnread()`（`hub.ts:~312,~380`）会推进其它池。
- 需求：唤醒开始时快照**所有**池游标（或让 hub 在每次 takeUnread 前回调记录原值），回滚/重试覆盖所有被推进的池。
- 验收：一轮中途另一池来消息并被 send 顺带读取，随后中止，断言该池游标回滚。

### B4 报错回滚无限重试【已核实：403 ×18】 ✅
- 位置：`app.ts:1176-1179`。
- 需求：
  1. 错误分类：`401/403/402`、key/额度/region/余额 → **不可重试**，不回滚游标（或回滚但暂停该类唤醒），发一次系统提示（按原因去重），并在概览标红；可考虑自动 `paused`。
  2. 可重试错误（网络、超时、5xx、429）复用重试账本 + 退避（如 立即 → 1min → 5min），上限 N 次。
  3. 失败的 prompt 不应留在会话里污染上下文（失败后回滚会话消息或换新会话）。
- 验收：mock 403 连续返回，断言最多 1 次调用 + 1 条提示，之后 tick 不再唤醒 LLM；mock 503 断言按退避重试且有上限。

### B5 放弃提示文案与去重不准确【待核实】
- 位置：`app.ts` `notifyAbort`。不可重试原因（审批拒绝、loop-guard、日额度）游标已推进，文案却说「消息还在，再发一句继续」；去重 key 只按原因，不按池。
- 需求：按原因分文案；去重 key 加上 pool。

### B6 回滚的消息被记忆梳理重复计数【待核实】 ⚠️ 部分完成
- 位置：`app.ts:~1196` `noteInboundMessages(unread)` / `maybeMemoryReview` 在回滚时仍执行。
- 需求：本轮发生回滚时跳过两者。

### B7 Matrix 先存 since 再处理【待核实】
- 位置：`adapters/matrix.ts:129-133`；另外未处理 `timeline.limited`；`stop()`→`start()` 可能并存两个 sync 循环（`:71-82`）。
- 需求：批次处理完成后再落盘 `next_batch`；`limited` 时记录缺口并计数（可选用 `prev_batch` 回补）；sync 用 AbortController + 代际 id。
- 验收：处理中途抛错/重启，断言重启后重新处理该批。

### B8 飞书 toInbound 失败时消息丢失【待核实，低频】
- 位置：`adapters/feishu.ts:~330`，先标记 seen 再 `toInbound`。
- 需求：转换成功后再标记，或失败时移除 seen 标记并记日志。

### B9 进程在 takeUnread 后崩溃【已知，见 TROUBLESHOOT §6】
- 需求：唤醒开始写 kv `wake.inflight = {pool: cursorBefore, ...}`，`finish()` 删除；启动时若存在则回滚游标并记日志。重试账本 `abortRetries` 同样落 kv/SQLite。
- 验收：写入 inflight 后直接构造新 App 启动，断言游标回滚。

---

## P1-C 减少「一轮里干长活」（体验根因）

### C1 超时前 steer 提醒
- 在 `runPrompt` 加软截止（如 `turnTimeoutMs * 0.7`），用 `pi.sendMessage({customType:"turn-deadline", content:"时间快到了：先 send 给用户一句当前进展/结论；没做完的建任务继续。", display:false}, {deliverAs:"steer"})`（与 `core/loopguard.ts:77` 同机制）。
- 重试唤醒（`abort-retry:*`）的 prompt 中明确：「上一轮超时未回复，直接基于交接/已有结论先回复，不要重做」。
- 验收：假模型在 steer 后调用 send，断言 wake `sentCount>0`。

### C2 每轮工具输出总预算【待核实部分】
- 现状：`read_file`/terminal 单次 8000 字符（中文约 8k tokens），无每轮总量；codemode 默认 10k tokens 输出且脚本可用 `@options max_output_tokens` 调大；`read_file` 目录列表不截断（`tools.ts:~1355`、`sandbox-fs.ts:~127`）。
- 需求：工具层维护每轮输出累计（按 token 估算），超预算后工具返回「本轮读取额度已用完，请先回复或建任务」；钳制 codemode 输出上限；目录列表上限（如 300 项）。参考 DS-Bot：超长内容落文件、内联只给开头。
- 验收：单测连续读取直至超预算，断言返回提示且不再附正文。

### C3（可选，较大）结构化转后台
- 参考 DS-Bot `bot-tasks.js shouldMoveForeground`：一轮已调用 ≥N 次工具或运行 ≥T 秒时，规则性地把剩余工作转为任务，前台先回复。先做 C1/C2，观察 wake 平均耗时是否回落再决定。

---

## P1-D 安全

### D1 沙盒持有完整管理 token【已核实】
- 位置：`app/src/api-token.ts:39` 把 `RB_API_TOKEN` 注入容器；容器默认 bridge 网络可访问宿主 API。仅宿主命令审批与读取白名单要求浏览器会话（`api.ts:~1026,~1039`）。
- 风险：被注入的模型可 `PUT /v1/send-review`（关出站审核）、`/v1/limits`（调预算）、`/v1/prompts/:name`、`/v1/persona`、飞书凭据等。
- 需求：为沙盒签发受限 token（只读 + 沙盒所需路由白名单）；所有修改配置的 PUT/POST/DELETE 要求浏览器会话（`webSession`）。
- 验收：api 测试——用沙盒 token 调上述写路由返回 403；浏览器会话可写。

### D2 terminal 校验与执行 cwd 不一致【已核实，docker 模式下潜伏】
- 位置：`tools.ts:~1477` 按 `hostCfg.cwd` classify，`:~1513` 把模型给的 `p.cwd` 传给 `execShell`，`ops/exec.ts:98` 覆盖 `hostCwd`；审批文案也显示配置 cwd。
- 需求：先解析 `p.cwd`，不在允许根目录内直接拒绝；classify、审批文案、执行使用同一个值。
- 验收：host 模式下 `cwd` 指向允许根外，断言拒绝；允许根内，断言审批文案显示真实 cwd。

### D3 agent 产出的 SVG 同源执行【待核实】
- 位置：`ops/outputs.ts:~43` 以 `image/svg+xml` 提供。
- 需求：outputs/raw 响应加 `Content-Security-Policy: sandbox` 与 `X-Content-Type-Options: nosniff`（或 SVG 以附件下载）。

### D4 登录无限速等【待核实】
- 位置：`api.ts:~401`、`core/web-auth.ts`；`scryptSync` 阻塞；默认监听 `0.0.0.0`（`default.json:~115`）；首次 setup 无认证。
- 需求：按 IP 失败退避；改异步 `scrypt`；无需容器访问时绑 127.0.0.1；setup 需 API token 或仅允许本机。

### D5 审批 reaction 可能匹配错消息【待核实】
- 位置：`core/approval.ts:~269` `onPrompt = !p.promptEventId || !m.reaction_to || ...`。
- 需求：仅当 `promptEventId` 已知且等于 `reaction_to` 才算命中。
- 验收：promptEventId 未知时对其它消息点 👍，断言不批准。

---

## P2 运维与可维护性

- **wake_log**：`tokensSince`（`db.ts:~1111`）每轮全表扫 + JS 解析 JSON；`repairBackfilledUsageCalls` 启动全表扫。需求：`ts` 加索引、去掉 `CAST`、增加 `tokens` 冗余列、保留 90 天。
- **迁移**：`db.ts:263-351` 的 `try{}catch{}` 吞所有错误。需求：只忽略 duplicate column；引入 `PRAGMA user_version`。
- **日志**：`core/logger.ts` 同步 `appendFileSync`，`wakes.jsonl` 不轮转（`logs/` 已 41MB）。需求：异步写 + 按大小/日期轮转。
- **记忆梳理**：fire-and-forget，`stop()` 不等待（`app.ts:~1197`、`:~365`）。需求：保存 promise，stop 时 await。

---

## 建议实施顺序

1. **PR1（P0-A + B1/B2/B4）**：engine 交接/中止重构 + 发送判定 + 错误分类。改动集中在 `engine.ts`、`app.ts`，配套测试放 `test/pipeline.test.ts` 与新建 `test/engine-abort.test.ts`。
2. **PR2（C1/C2）**：软截止 steer + 每轮工具输出预算。上线后观察一周 wake 平均耗时与 timeout 次数。
3. **PR3（D1/D2/D3/D5）**：安全收口。
4. **PR4（B3/B7/B8/B9 + P2）**：持久化 inflight、Matrix、数据库与日志。

## 通用验收

每个 PR：

```bash
cd app
npm run typecheck && npm test
npm run build && pm2 restart rabbit-bot   # 后端
npm run web:typecheck && npm run web:build # 若改前端
```

上线后观察（第 0 节 SQL）：`aborted:*` 与 `error` 次数、平均 `ms`、`sentCount=0` 的私聊唤醒数；概览页「最近异常」应无长期残留。

## 参考：DS-Bot 可借鉴点（`/Users/viking/projects/pub-repos/DS-Bot/ds-bot/src/host/`）

- 无硬墙钟超时，用「无进展」空闲计时（`groups.js:~1184`）；用户新消息可 steer 打断当前调用（`steer.js:~118`）。
- 上下文检查只在一轮干净结束后或下一步之前；上一轮报错则跳过（`parts.js:~1696`）；溢出错误直接换会话不写笔记（`parts.js:~1665`）；笔记失败保留旧会话并退避（`parts.js:~191,~1337`）。
- 每条投递消息写 `inflight.json`，被一轮真正接手才清除；启动一次性恢复，`record.resumed` 防循环（`resume.js`）。
- 忙时按结构规则把前台转为后台任务（`bot-tasks.js:~703`）。
- LLM 只重试 TRANSPORT/TIMEOUT/MALFORMED，其余交给用户修（`models.js`、`turns.js:~939`）。
- 设计依据：`docs/plans/2026-10-09-context-and-memory.md`、`2026-11-16-async-work.md`。
