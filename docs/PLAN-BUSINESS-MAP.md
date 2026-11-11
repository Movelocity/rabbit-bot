# rabbit-bot 业务地图开发计划：从“猜关系”到“查地图”

> 定位：把 BKN《本体驱动的业务关系组织》里可复现的部分裁小，落到 rabbit-bot 的 UFA/WA 上。
> 前置阅读：`docs/PLAN-UFA-WA-DSH-ALIGNMENT.md`（UFA/WA 分层）、`docs/ARCH-UFA-WA.md`（行为）。
> 状态：P0 已实施（2026-11-10），`npm run typecheck` + 504 tests 全绿。待拍板项见第 9 节。
>
> 2026-11-11 更新：存储已从 `runtime/business/*.json` 迁到 SQLite（`business_*` 表）。运行时只读 Store；写入走 `GET/PUT /v1/business` 全量快照；旧 JSON 只在首次启动导入一次。下文关于文件、mapping、deploy 文件的内容保留作历史设计，当前字段以技能库 `_shared/business-map-schema.md` 为准。

---

## 0. 结论先行

1. **业务理解的关键不是更多 prompt，而是显式关系。** 把“对象和关系”从聊天上下文里拿出来，落成一份人可读、可 diff 的 `runtime/business/*.json`；agent 先看地图，再沿路径取证据。
2. **P0 不上向量、不上图数据库。** 业务地图初期只有几十到几百个对象，精确 id、别名、词法匹配 + 让模型看候选就够。向量只在有明确失败案例后再加（第 4.4 节给了触发条件）。
3. **最小闭环五件事**：`business/` 四个 JSON、`map` 工具、system prompt 只放索引、任务文档注入“业务上下文”、汇报写 `used_relations`。
4. **只声明 8–10 条高频关系**（repo→service、service→env、project→repo、person→repo 这类），不要一上来做全自动关系发现。
5. **关系实例默认不物化**：用 mapping 规则在查询时算（文档 P4）；rabbit-bot 里规则可以简单到“手工列表 / JSON 文件 / glob”。

---

## 1. 问题与目标

### 1.1 现状

| 层 | 现在 | 差距 |
| --- | --- | --- |
| 记忆 | `memory` 有 fact / plan / alias / topic（`app/src/ops/memories.ts`） | 是**事实**，不是**结构关系**；“这个项目包含哪些服务、改 A 会影响 B”没有落点 |
| 任务 | `task` 有 goal / deliverable / constraints / acceptance / files（`app/src/core/tasks.ts`） | WA 拿不到“涉及哪些对象、沿哪条关系、不能碰什么” |
| 工具 | UFA 有 `chat/memory/plan/task/worker/read_file/terminal/rb`（`app/src/agent/tools.ts`） | 没有“查业务地图”的入口 |
| 提示词 | persona + 行为规范（`app/prompts/system.md`） | 没有业务骨架；关系全靠模型临场猜 |
| 汇报 | `shared/task-<id>.md`（`app/src/core/dispatch.ts`） | 没有“用了哪些关系、证据是什么”的追溯 |

### 1.2 目标

- 用户说“那个项目 / 老地方 / 这个服务”时，agent 能解析到明确对象，而不是猜。
- 建任务前能给出对象、关系路径、影响面、禁止项；WA 拿到的任务文档带业务上下文。
- 回答和汇报能追溯到“对象 → 关系 → 数据源/文件”，可审计。
- 地图变更只改文本，不改查询代码。

### 1.3 非目标

- 不做完整 BKN 平台，不做图数据库，不做全自动关系发现。
- P0 不做向量检索、不做 embedding 管道。
- 不把“业务语义”形式化成完备逻辑系统；`semantics` 只是给人/模型看的自然语言。
- 不把业务地图当安全边界；host 模式下它只是行为约束和审计线索。

---

## 2. 设计原则（从 BKN 文档裁小）

| 文档命题 | rabbit-bot 里的落法 |
| --- | --- |
| P1 关系优先 | `relations.json` 与 `objects.json` 平级；关系可单独命名、引用、审查 |
| P2 声明式、人机可读 | JSON + `semantics` 自然语言；改地图不用改代码 |
| P3 语义与物理分离 | `object.type` 说“业务上是什么”，`source`/`mapping` 说“去哪取” |
| P4 运行时实例化 | 关系实例由 `mapping` 查询时算，不落边表 |
| P5 渐进式披露 | prompt 只放索引；`map show/path` 逐层下钻；限制深度和扇出 |
| P6 关系即治理轴 | 任务带 `objects/relations/forbidden`；`map impact` 找影响面；汇报写 `used_relations` |

---

## 3. 数据模型

### 3.1 目录

```
<runtimeDir>/business/
  objects.json
  relations.json
  actions.json
  glossary.json
```

- 默认 `<runtimeDir>` = `~/.config/rabbit-bot/runtime`（`app/src/core/runtime.ts`）。
- 地图是私有业务数据，只放 runtime，不进 git；仓库里只放示例（`docs/examples/business/`）。
- 文件缺失 = 没配业务地图，所有功能降级为“无地图”，不报错。

### 3.2 `objects.json`

```json
{
  "version": 1,
  "types": [
    { "id": "project", "name": "项目", "description": "一个长期工作目标" },
    { "id": "repo", "name": "代码仓库", "description": "一个 git 仓库" },
    { "id": "service", "name": "服务", "description": "可部署的运行单元" },
    { "id": "env", "name": "环境", "description": "dev / staging / prod" },
    { "id": "person", "name": "人", "description": "参与项目的人" }
  ],
  "objects": [
    {
      "id": "project:rabbit-bot",
      "type": "project",
      "name": "rabbit-bot",
      "aliases": ["兔子机器人", "这个 bot"],
      "description": "个人 IM 聊天与任务 agent",
      "key": { "kind": "path", "value": "/Users/viking/projects/rabbit-bot" },
      "source": { "kind": "path", "value": "/Users/viking/projects/rabbit-bot" },
      "tags": ["active"]
    },
    {
      "id": "service:rabbit-bot-admin",
      "type": "service",
      "name": "admin",
      "aliases": ["管理后台"],
      "description": "rabbit-bot 的 Web 管理页",
      "key": { "kind": "name", "value": "admin" },
      "source": { "kind": "path", "value": "/Users/viking/projects/rabbit-bot/app" }
    }
  ]
}
```

字段约定：

- `id`：全局唯一，建议 `type:slug`；关系两端都用它。
- `type`：必须在 `types[].id` 里。
- `aliases`：用户口语；`map resolve` 会用到。
- `key`：业务主键，`kind` 取 `path | name | id | field`。
- `source`：去哪找实体；P0 只用于展示和 `path/glob` 映射。
- 单个文件上限 512KB、对象数上限 2000（超过就提示先分组/上 FTS）。

### 3.3 `relations.json`

```json
{
  "version": 1,
  "relations": [
    {
      "id": "service_deploys_to_env",
      "name": "deploys_to",
      "fromType": "service",
      "toType": "env",
      "kind": "file",
      "mapping": {
        "kind": "file",
        "file": "deploy/{env}.json",
        "select": "services[]"
      },
      "cardinality": "N:N",
      "direction": "forward",
      "risk": "high",
      "semantics": "服务当前部署在哪些环境；改服务前先看这条，发布前用 map impact 看影响面"
    },
    {
      "id": "repo_belongs_to_project",
      "name": "belongs_to",
      "fromType": "repo",
      "toType": "project",
      "kind": "manual",
      "mapping": {
        "kind": "manual",
        "edges": [
          { "from": "repo:rabbit-bot", "to": "project:rabbit-bot" }
        ]
      },
      "cardinality": "N:1",
      "direction": "forward",
      "risk": "low",
      "semantics": "仓库归属哪个项目"
    }
  ]
}
```

`mapping.kind` 的 P0 已实现范围：

| kind | 含义 | 示例 |
| --- | --- | --- |
| `manual` | 显式边列表 | 上面的 `repo_belongs_to_project` |
| `file` | 读一个 JSON 文件，按 `select` 取 id 列表，连到 `to` 的所有实例 | `deploy/prod.json` 的 `services[]` |

P1/P2 再考虑：

- `glob`：在 `root` 下按 glob 找文件，文件名/路径映射到对象 key。
- `field`：两条结构化对象按字段相等配对（订单 `customer_id` = 客户 `id`）。
- `command`：跑一条**只读**命令取实例（`git remote -v`、`docker compose config --services`），必须走白名单、超时、无 shell 插值。

约束：

- `fromType`/`toType` 必须在 `types` 里；`mapping` 必须能产出 `{from,to}` 对。
- 关系实例不落库；`map path` 每次按规则算。
- 映射规则不能写 token、密码、绝对家目录里的敏感目录。

### 3.4 `actions.json`

```json
{
  "version": 1,
  "actions": [
    {
      "id": "deploy",
      "name": "发布",
      "appliesTo": ["service"],
      "risk": "high",
      "requiresRelations": ["service_deploys_to_env"],
      "description": "把服务发布到环境；必须先看影响面并拿到审批"
    }
  ]
}
```

P0 只用于任务上下文提示，不自动执行。真正执行仍走 `terminal` + 审批。

### 3.5 `glossary.json`

```json
{
  "version": 1,
  "terms": [
    { "term": "老地方", "objectId": "env:prod", "note": "他说的老地方一般指生产" },
    { "term": "管理后台", "objectId": "service:rabbit-bot-admin" }
  ]
}
```

- 和 `memory` 的 `alias` 分工：`glossary` 是**结构术语**，`memory.alias` 是**对话里的临时说法**。二者冲突时，`map resolve` 先返回 glossary，再补 memory 候选，并把冲突标出来。
- P0 只读 glossary；P1 再考虑把 memory alias 桥接进来。

### 3.6 校验

`map check`（P1）或启动时 `loadMap` 做：

- id 唯一；`type`/`fromType`/`toType` 存在。
- `mapping` 必填且 kind 合法；`manual` 边两端的对象存在。
- `cardinality` ∈ `1:1 / 1:N / N:1 / N:N`；`direction` ∈ `forward / both`。
- 文件大小、对象数、关系数上限；不出现 `token/password/secret` 字样。

---

## 4. 运行时行为

### 4.1 `map` 工具（UFA 只读）

在 `app/src/agent/tools.ts` 里新增一个工具，只进 `ufaTools`：

| action | 返回 | 限制 |
| --- | --- | --- |
| `index` | 类型清单 + 关系名 + 数量，不含实例 | 200 行内 |
| `show <id>` | 对象卡片 + 直接邻居（关系名/方向/对端） | 20 个邻居 |
| `resolve <说法>` | 候选对象（id/type/name/score），不足就返回“没找到” | 10 个候选 |
| `path <from> <to>` | 逐跳证据子图 + 关系路径 | 深度 ≤ 4，每层 ≤ 50 |
| `impact <id>` | 反向可达对象（改这个会影响谁） | 深度 ≤ 3，结果 ≤ 50 |
| `check` | 校验问题清单 | P1 |
| `help` | 用法 | — |

输出给模型时用紧凑文本（id + 名称 + 关系），不要整份 JSON。

### 4.2 渐进式披露

- `systemPrompt` 只注入 1–2 行：`业务地图：5 类对象 / 12 条关系；用 map 工具查（index/show/path/impact）。` 没有地图就不注入。
- 不在 prompt 里放对象实例、关系实例、`semantics` 全文。
- `map index` 只给骨架；要细节必须继续调 `show/path`。
- 所有返回都有上限，超限提示“还有 N 个，用过滤条件缩小”。

### 4.3 任务上下文

`task` 工具 `action=create` 增加可选参数：

- `objects?: string[]`：这条任务涉及的对象 id。
- `relations?: string[]`：必须遵守/关注的关系 id。
- `forbidden?: string[]`：不能碰的对象 id 或关系 id。

落库：`tasks` 表加一列 `context TEXT NOT NULL DEFAULT '{}'`（`app/src/core/db.ts` 的增量迁移），内容：

```json
{ "objects": ["service:rabbit-bot-admin"], "relations": ["service_deploys_to_env"], "forbidden": ["env:prod"] }
```

`renderTaskDoc`（`app/src/core/dispatch.ts`）增加一段，只有 `context` 非空才输出：

```markdown
## 业务上下文

- 对象：service:rabbit-bot-admin（管理后台）
- 关系：service:rabbit-bot-admin --deploys_to--> env:staging
- 禁止：不要写 env:prod
- 影响面：改动该服务会影响 env:staging；发布前先确认
- 可用动作：deploy（高风险，需审批）
```

`writeTaskDoc` 在 start/resume 时都会重新渲染，所以上下文字段必须持久化在 tasks 表，不能只写在第一次的文档里。

### 4.4 检索顺序（P0 不做向量）

`map resolve` 的顺序固定：

1. 精确：`id` / `key.value` / `type:name`；
2. 别名：`object.aliases` + `glossary.term`；
3. 词法：把对象卡片（name + aliases + description + tags）做小写包含/词重叠打分；
4. 不到 3 个确定结果时，返回候选让模型/用户选，**不猜**。

P0 在内存里做第 3 步；对象数超过约 300 再上 SQLite FTS5。向量检索的触发条件：

- 对象数 > 500，或对象描述是长文本；
- 真实 query 里“说法和 id/字段/别名都对不上”的比例高；
- 评测显示 schema 定位是主要错误来源，而不是路径选择；
- 有 20–50 道真实问题能量化收益。

即使加，也只对“对象卡片”做 embedding，取 top-k 带阈值，**绝不用相似度补关系或造边**。

### 4.5 治理

- 任务创建时校验 `objects/relations/forbidden` 是否存在；不存在就报错并给候选。
- 高风险关系（`risk: high`）或 `actions.risk=high`：建任务前提示先 `map impact`，任务文档里写明。
- 汇报模板加追溯段（P1）：`used_relations`、`evidence`（对象/文件/命令输出）。
- 这不是权限系统；host 模式下真正执行仍靠 `terminal` 审批。关系级治理是“让越权动作显眼、可审计”。

---

## 5. 代码改动清单

| 文件 | 改动 | 阶段 |
| --- | --- | --- |
| `app/src/ops/business-map.ts` | 新增：加载、校验、索引、resolve、show、path、impact、renderIndex | P0 |
| `app/src/agent/tools.ts` | 新增 `map` 工具（UFA only）；`task` create 增加 objects/relations/forbidden | P0 |
| `app/src/core/db.ts` | `tasks` 加 `context TEXT NOT NULL DEFAULT '{}'` 迁移 | P0 |
| `app/src/core/tasks.ts` | `Task` / `CreateTaskInput` / `PATCH_KEYS` 支持 `context` | P0 |
| `app/src/core/dispatch.ts` | `renderTaskDoc` 增加“业务上下文”；汇报模板加追溯提示 | P0 |
| `app/src/agent/prompt.ts` + `app/prompts/system.md` | 注入地图索引（有地图才注入） | P0 |
| `app/src/core/runtime.ts` | 加 `businessDir(cfg)` + `ensureRuntime` 子目录 | P0 |
| `docs/examples/business/*.json` | 最小示例（供应链或 rabbit-bot 自身） | P0 |
| `app/test/business-map.test.ts` | 加载/校验/resolve/path/impact/缺文件/环/上限 | P0 |
| `app/test/pipeline.test.ts` | 建任务带 objects → 任务文档出现业务上下文 | P0 |
| `app/src/api.ts` | （可选）`GET /v1/business/index` 给 WA 读；P0 先只靠任务文档 | P2 |
| `app/src/ops/business-map.ts` | `check`、glossary↔memory alias 桥接 | P1 |
| `app/src/ops/business-map.ts` | `field` / `command` 映射（只读白名单） | P2 |
| `app/test/business-bench.test.ts` | 20–50 题评测夹具 | P2 |

不新增依赖：JSON 解析用 Node 内置；FTS5 用 `better-sqlite3` 自带能力；向量 P3 才考虑。

---

## 6. 分阶段

### P0：最小可用（已完成）

- `business/` 四个 JSON 的 schema + 示例（`docs/examples/business/`）。
- `app/src/ops/business-map.ts`：load（定义文件 + mapping 数据文件双层 mtime 缓存）、validate、index、resolve（精确/别名/术语/词法）、show、path、impact、renderTaskContext。
- `map` 工具（UFA only，WA 没有）。
- `systemPrompt` 注入一行索引；没有地图就不注入。
- `task` create 接收 `objects/relations/forbidden`；`tasks.context` 落库；`renderTaskDoc` 输出“业务上下文”，start/resume 后仍在。
- 测试：`app/test/business-map.test.ts` 11 条（加载/校验/resolve/show/path/impact/文件变更/工具/任务上下文/prompt）。
- 验收：`map path service:rabbit-bot-admin env:prod` 能走 `deploys_to`；带 context 的任务文档出现业务上下文；没有地图时一切照旧。

### P1：追溯与消解（2–3 天）

- `glob` mapping。
- `map check`；启动/保存时校验。
- `map resolve` 接 `memory.alias`，冲突时列候选。
- 汇报模板要求 `used_relations` / `evidence`；`complete` 时把追溯写进任务事件。
- `task` 工具 `action=get/list` 返回 context。
- 验收：重复 complete 不重复写追溯；坏地图能指出具体行/对象。

### P2：虚拟边与评测（3–5 天）

- `field` / `command` mapping；命令只读白名单、超时、无 shell 插值。
- 可选 `GET /v1/business/index|show|path` 给 WA 用（现在只靠任务文档）。
- 20–50 道真实工作问题的评测集 + 指标。
- 验收：改 `deploy/prod.json` 后，`map path` 不重建任何表就能看到新边。

### P3：条件触发（按需）

- 只有 P2 评测证明“定位是瓶颈”才加向量兜底。
- 关系级治理再往前走：按对象/关系裁剪 WA 可见范围（需要独立的执行账号或沙盒，host 模式下仅提示）。

---

## 7. 整体验收清单

- [x] `runtime/business/` 有地图时，`map index/show/path/impact` 可用；没有时所有功能正常降级。
- [x] `map path` 有深度/结果上限；超过时返回“还有 N 个”或空路径，不静默截断到假装有边。
- [x] 任务带 objects 时，任务文档出现“业务上下文”；start/resume 后仍在。
- [x] 建任务时传不存在的 object/relation 会报错并给候选。
- [ ] 汇报里有 `used_relations` / evidence（P1）。
- [x] 改 mapping 数据文件后，`map path` 无需重启/重建即可反映。
- [x] 没有新增运行时依赖；`npm run typecheck` + `npm test` 全绿（504）。
- [ ] 评测集能区分“无关系”和“无数据”两类负例（P2）。

---

## 8. 评测

### 8.1 问题集

20–50 道真实工作问题，按能力分层（每题记录标准答案、最少必要路径、可接受路径、禁止对象）：

- 单对象：“管理后台在哪个仓库？”
- 单跳：“这个服务部署在哪些环境？”
- 多跳：“改 admin 会影响哪些环境/项目？”
- 聚合：“这个项目下哪些服务是高风险？”
- 负例：“admin 和支付服务有关系吗？”（正确回答“没有关系”，不是“没数据”）
- 越权：“以只读角色改 prod 会怎样？”

### 8.2 指标

- 实体解析准确率（resolve 命中正确对象）。
- 路径精度/召回（关系序列 vs 标准路径）。
- 证据覆盖率（答案每个事实能否追到对象/关系/文件）。
- 工具步数、输入/输出 token、P50/P90 延迟。
- 错误关系率、负例编造率（目标为零）。
- 地图维护成本：新增一条关系要改几行、是否要动代码。

### 8.3 方法

- 固定地图版本 + 模型配置；同一题对比“有地图 / 无地图 / 全量地图塞 prompt”三种条件。
- 先跑“骨架 + 按需下钻”，确认比“全量塞 prompt”少 token 且不降正确率。
- 不追求数值和 BKN 原文一致，只看方向与负例是否守住。

---

## 9. 决策落点（执行时按建议定）

1. **地图位置**：只放 runtime（已实现，`businessDir(cfg)`）；仓库只留 `docs/examples/business/`。
2. **context 持久化**：加 `tasks.context` 列（已实现，增量迁移）。
3. **glossary 与 memory alias**：P0 只读 glossary（已实现）；P1 再桥接 memory，冲突列候选。
4. **P0 mapping 范围**：已实现 `manual + file`；`glob` 顺延到 P1，`command` 留到 P2。
5. **WA 获取上下文**：P0 只写任务文档（已实现）；P2 再看要不要开 `/v1/business`。
6. **对象/关系规模**：先控制在 `≤ 2000 对象 / ≤ 200 关系`（代码上限）；实际建议 ≤ 200 / ≤ 30，超过再上 FTS/向量。
