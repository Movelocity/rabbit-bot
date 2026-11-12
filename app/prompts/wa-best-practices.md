# WA 通用最佳实践

所有一次性执行任务共用这份约定。开工前先读它；任务文档和用户原话优先于这里。

## 开工

1. 先读任务文档 `<work_dir>/.ufa/tasks/task-<id>.md`，再读仓库的 `AGENTS.md` / `README`。
2. 到 shared 里找同主题的旧交接：
   `rg -l "关键词" "$RB_SHARED_DIR" -g 'task-*.md'`
   新交接在 `handoffs/`，老任务可能还留在 shared 根；都算线索。
   旧交接只当线索，先核实再复用；不要因为旧文档写过就照抄。
3. 调一次 `progress`（`stage=working`），然后开工。

## 业务地图（business map）

业务地图存在 SQLite（`app/data/rabbit-bot.db` 的 `business_*` 表），运行时只读它。
`runtime/business/*.json` 只是**首次启动的种子**：库里已有地图后，改文件不会生效，别用 write_file 改它。

### 读（本地直接可用）

本地 worker 环境里有 `$RB_APP_DIR`（rabbit-bot/app 的宿主路径），直接：

```bash
npm --prefix "$RB_APP_DIR" run map -- index
npm --prefix "$RB_APP_DIR" run map -- graphs
npm --prefix "$RB_APP_DIR" run map -- show <object-id>
npm --prefix "$RB_APP_DIR" run map -- resolve <说法>
npm --prefix "$RB_APP_DIR" run map -- path <from> <to>
npm --prefix "$RB_APP_DIR" run map -- impact <id>
npm --prefix "$RB_APP_DIR" run map -- lint
```

没有 `$RB_APP_DIR` 时，`cd` 到 rabbit-bot 的 `app/` 再跑 `npm run map -- ...`。

也可以走 API（token 在 `$RB_API_TOKEN`，响应包在 `{ ok, data }` 里，取 `.data`）：

```bash
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_BASE/v1/business"
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_BASE/v1/business/lint"
```

### 写（维护）

1. 先 `GET $RB_API_BASE/v1/business` 拿全量快照。
2. 在快照上改对象 / 关系 / 边 / 动作 / 术语。
3. `PUT $RB_API_BASE/v1/business` 全量写回（替换语义，漏掉的数组会被清空）。
4. 写完重新 GET 核对，再 GET `/v1/business/lint`。

不要直接重导入或拿文件覆盖。库里可能有多张图（例如 `default`、`codex`），PUT 时先把别的图原样保留。

### graph_id

- `types` 全局共享；对象、关系、边各自带 `graph_id`，不传就是 `default`。
- 边必须和它的关系、两端对象在同一张图；跨图连边会被拒绝。
- **新建图不是新建文件**：给一批对象 / 关系 / 边统一写新的 `graph_id`（例如 `runsenshen`），再 PUT。
- `import_batch` 只做来源标记，不参与业务判断。

字段和限制看 `../_shared/business-map-schema.md`；更细的维护流程看 `wa-business-map` 技能。
要设计/清洗/评审关系结构（类型预算、关系族收敛、健康度指标），读 `~/.agents/skill-library/rabbit-bot/business-relation-modeling/SKILL.md`。

## 做事

- 只在 `work_dir` 内读写和运行命令，不越界。
- 先看现有实现、约定和测试，再改；小步改，别顺手重构、别扩大范围。
- 常规实现细节自己定；只有改对外接口、跨模块、产品/设计方向没定、缺权限/资源时，才停下来报 `blocked`。
- 不编结果：没跑过的验证不写“已通过”，没测过的指标不报。
- 不轮询、不 `sleep`。长命令放后台或结束回合，等事件唤醒。
- 不把 token、密钥、私有内容写进文档、日志或交接文件。
- 任务卡住时先自己尝试可行替代；确实过不去，再带证据报卡点。

## 交接文档

固定写到 `$RB_SHARED_DIR/handoffs/task-<id>.md`，覆盖写。建议结构：

```markdown
# task-<id>：一句话标题
日期：
关键词：项目、模块、实体、错误码（方便后来者 rg）

## 目标
## 做了什么
## 关键决定与原因
## 验证
（跑过的命令、测试、结果；没验证的写清楚）
## 产出
（文件绝对路径或链接）
## 遗留 / 风险
## 给下一个任务的线索
```

短而可检索；不要贴大段日志。交接文件不是完成信号，`complete` 才是。

## 产出落点

- 最终交付物复制或导出到 `$RB_SHARED_DIR/outputs/task-<id>/`，不要只留在工作目录。
- 项目经理在沙盒里通过 `/work/shared/outputs/` 验收。
- `artifact` 填 shared 产出路径；工作目录里的原始路径写进交接文档。
- 数据类产出（xlsx/csv）尤其要放这里，否则项目经理看不到，等于没交付。

## 汇报口径

- `result`：用户能看懂的结果，一两句。
- `artifact`：`$RB_SHARED_DIR/outputs/task-<id>/...` 的路径。
- `blocked`：卡在哪、试过什么、缺什么、需要谁做什么。
- 技术细节留在交接文件，IM 里只给结论和可复核的线索。
