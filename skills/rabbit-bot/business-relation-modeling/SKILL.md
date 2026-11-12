---
name: rabbit-bot-business-relation-modeling
description: 业务关系梳理最佳实践：把业务对象、类型、关系族、证据和健康指标整理成可复用、可检索的业务地图。当需要设计/清洗/评审业务关系图，判断一张图是否清晰，或把代码/文档事实转成业务对象和关系时使用。
---

# 业务关系梳理最佳实践

目标不是「把知道的关系都画出来」，而是做一张**业务本体图**：类型稳定、关系可复用、每条边有证据、能按 schema → 实例 → 路径逐层查。

## 先判断图的目标

- 业务图：读者是人/Agent，回答「谁属于谁、谁负责、部署到哪、影响谁」。
- 代码图：读者是工程排查，回答「哪个模块调哪个表」。
- 两者不要混：代码层类型（DTO / 表 / 入口 / 契约）不进业务图；需要就单独 `graph_id`，并标明 `layer=code`。

## 五条硬原则

1. **类型是业务名词，不是代码分层。**
   - 好：project / repo / service / env / person / external_system / data_source / business_package / delivery_stage / business_scope。
   - 坏：codex_dto / plugin_table / service_entry / shared_contract。
   - 预算：业务图 ≤12 类；单例类型 = 0；平均每类 ≥8 个对象。新增类型先回答「现有类型为什么装不下」。

2. **关系族是 schema，不是边清单。**
   - 一个谓词服务多个端点，用端点类型约束区分；不要为每个端点组合新建一个族。
   - 目标：边/关系族 ≥2，健康图 ≥4；单边族占比尽量低；同谓词拆族（`_extra`、`_env`、`_scope`…）必须合并或写清语义差异。
   - 优先稳定动词：`belongs_to` / `deploys_to` / `responsible_for` / `has_part` / `uses` / `depends_on` / `provides`。

3. **一个对象只表达一个可独立识别的概念。**
   - 名称里出现 `A / B`、`A或B`，先拆。
   - 自环（A→A）通常意味着概念合并或关系写错，直接查。
   - 配置小节、命令、文件、DTO 不是业务对象；它们是属性、动作，或代码图里的对象。

4. **证据是准入条件，不是备注。**
   - 每个对象有 `source`；每条边有 `evidence`（文件:行 + 原文 / 用户原话 / 命令输出）。
   - 代码行证据只证明「代码里存在」，不等于「业务上存在」；进业务图前先映射成业务对象。
   - 找不到证据的进「待确认」，不要入库。

5. **先 schema 后实例。**
   - 索引先给类型、关系族、每族边数、连通分量、孤立对象；再按 `show` / `path` / `impact` 下钻。
   - 不要靠对象名猜关系；地图里没有就说没有。

## 健康度指标（评审用）

| 指标 | 健康信号 | 报警参考 | 反例 |
|---|---|---|---|
| 最大连通分量占比 | ≥50% | <50% | codex 17.7%（default 77.5%） |
| 边/关系族 | ≥1.5，健康 ≥4 | <1.5 | codex 1.02（default 4.62） |
| 单例类型占比 | 0% | >20% | codex 40.7% |
| 单边关系族占比 | ≤50%，目标 ≤20% | >50% | codex 98.1%（default 43.8%） |
| 平均对象/类型 | ≥8 | <4 | codex 2.93（default 12.0） |
| 同类型内部边占比 | ≤50% | >50% | codex 58.2%（default 10.1%） |
| 对象/边证据覆盖 | 尽量 100% | 有 source 无 evidence | 只把证据写在描述里 |

注意：孤立对象数量本身不是关键信号（两张图都可能只有 4 个）；**结构碎片化**才是。单边族在 default 也有 43.8%——它是清理项，不是一票否决；但到 codex 的 98.1% 就已经不是 schema 了。

## 工作流

1. **定图和范围**：明确 `graph_id`（新建图还是并入现有图）、读者、输入文档、验收人。新建图不是新建文件，是给对象/关系/边统一写新的 `graph_id`。
2. **抽对象**：从文档/代码里抽业务名词，按 id/name/alias 去重；同一概念只留一个主对象，其他名字进 alias。先套类型预算，再补对象。
3. **定关系**：先列谓词清单，再把每条事实映射到规范谓词；检查每族边数，合并 `_extra`/同谓词拆族；发现自环、多概念对象立刻拆。
4. **补证据**：对象写 source，边写 evidence；代码证据标 `kind=code`，业务证据标来源文档；缺证据的进「待确认」。
5. **写入**：`GET /v1/business` 拿全量快照 → 改 → `PUT /v1/business`。PUT 是替换语义，必须保留其他图；不要直接重导入或拿 `runtime/business/*.json` 覆盖。
6. **验收**：重新 GET 核对对象/关系/边和分图计数；跑 lint 和健康度指标；用 `map index/show/resolve/path/impact` 抽查关键路径。
7. **汇报**：改了哪些 id、落在哪个 `graph_id`、前后指标、证据位置、pending 清单、风险和下一步。

## 反模式（看到就停下来改）

- **一事实一族**：`skill_has_tags`、`release_has_tags`、`plugin_has_tags` 各建一族。应合并为 `has_tags` + 端点类型约束。
- **一个对象塞两个概念**：`SyncSource / SyncRun` 合成一个对象，最后连出自环。
- **类型爆炸**：27 类里 11 个单例；类型数随实现文件增长，而不是随业务概念增长。
- **代码图混进业务图**：DTO、表、Tauri 命令、运行时进程都当业务对象。
- **近似重名大簇**：plugin 23 个、skill 15 个、thread 9 个；人和 Agent 都无法判断哪个是业务对象、哪个是实现细节。
- **局部有边、全局碎片化**：每条边单看都成立，整图却是 27 个连通分量、最大分量只有 17.7%。
- **证据只写在 description**：查询和 lint 用不上；证据要进结构化字段。
- **直接全量覆盖**：没先 GET、没保留其他图，PUT 一次就把 `codex` 等图清掉。

## rabbit-bot 检查命令

```bash
# 本地只读（不需要 token）
npm --prefix "$RB_APP_DIR" run map -- graphs
npm --prefix "$RB_APP_DIR" run map -- index
npm --prefix "$RB_APP_DIR" run map -- lint
npm --prefix "$RB_APP_DIR" run map -- show <id>
npm --prefix "$RB_APP_DIR" run map -- resolve <说法>
npm --prefix "$RB_APP_DIR" run map -- path <from> <to>
npm --prefix "$RB_APP_DIR" run map -- impact <id>

# 运行时读写（响应包在 {ok,data} 里）
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_BASE/v1/business"
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_BASE/v1/business/lint"
```

写入细则看 `wa-business-map` 技能；字段限制看 `_shared/business-map-schema.md`（都在 rabbit-bot 技能库 `~/.agents/skill-library/rabbit-bot/` 下）。UFA 直接用 `map` 工具，不必跑 CLI。

## 最小验收清单

- [ ] 业务类型 ≤12，无单例类型，平均对象/类型 ≥8
- [ ] 边/关系族 ≥1.5，单边族已解释或合并
- [ ] 最大连通分量 ≥50%，没有明显孤岛
- [ ] 无自环、无 `A / B` 多概念对象、无近似重名冲突
- [ ] 每个对象有 source，每条边有 evidence；pending 单列
- [ ] `GET /v1/business` 分图计数与预期一致
- [ ] `map index/show/path/impact` 能查到关键路径
- [ ] lint 无新增 error；健康度指标有前后对比
