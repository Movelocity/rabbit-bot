---
name: rabbit-bot-wa-business-map
description: WA 侧业务地图维护：在 runtime/business 下增删改 objects/relations/actions/glossary/deploy，要求每条有证据、不猜关系，改完用 map 工具和测试验证。当 WA 接到业务关系入库、对象/关系修改、部署映射、影响面分析任务时使用。
---

# WA：业务地图维护

WA 是编辑者。只改有证据的东西；没有依据的进「待确认」，不要替主人补。

## 谁写

- **WA 写**：用 `write_file` 改 `<runtime>/business/*.json`，用 `terminal` 跑校验。
- **UFA 只读**：UFA 用 `map` 工具查，不直接改；改动由 UFA 建任务交给你。
- **人拍板**：谁属于谁、谁部署到哪、谁负责，最终由主人确认。

运行时目录默认 `~/.config/rabbit-bot/runtime`，可用 `RABBIT_BOT_RUNTIME` 覆盖。业务地图在 `<runtime>/business/`。

## 文件

| 文件 | 必填 | 内容 |
|---|---|---|
| `objects.json` | 是 | `version` + `types[]` + `objects[]` |
| `relations.json` | 否 | `version` + `relations[]` |
| `actions.json` | 否 | `version` + `actions[]` |
| `glossary.json` | 否 | `version` + `terms[]` |
| `deploy/{env}.json` | 按需 | `file` 类型关系的数据文件，不是 schema |

字段级说明、限制和报错见 `../_shared/business-map-schema.md`。

## 维护流程

1. **先读现状**
   - 读 `objects.json` / `relations.json` / `actions.json` / `glossary.json`。
   - 新建对象前按 id、`key.value`、`name`、`aliases` 查重，别因为一个别名又建一个。
   - 有 `map` 工具的环境里，先用 `map index` / `map resolve` 确认。

2. **找证据**
   - 每个新增/修改都要能指到来源：文件路径 + 原文片段、命令输出、或主人明确说过。
   - 找不到来源的，列进「待确认」，不要写进正式地图。
   - 不把「看起来合理」当成关系。尤其不要猜负责人、部署环境、服务归属。

3. **改对象**
   - `id` 用 `type:slug`，稳定、可读，例如 `service:rabbit-bot-api`。
   - `type` 必须已经在 `types` 里声明。
   - `name` 必填；`aliases` 只收真实叫法；`description` 说清它是什么。
   - `source` 写路径/URL；`key` 写能唯一定位的值，方便 `file` 映射匹配。

4. **改关系**
   - `id` 稳定，建议 `from_to_relation` 风格；`name` 是关系动词，例如 `belongs_to` / `deploys_to` / `owns`。
   - `fromType` / `toType` 必须在 `types` 里声明。
   - `manual`：`mapping.edges` 里的 `from` / `to` 必须是已存在的对象 id。
   - `file`：`mapping.file` 相对 business 目录，支持 `{env}` / `{id}` / `{type}` / `{name}` / `{slug}` / `{key}`；`mapping.select` 用点路径，数组写 `[]`，例如 `services[]`。
   - `risk=high` 的关系必须写 `semantics`，说明改它会影响什么。
   - `direction` 只填 `forward` 或 `both`；`cardinality` 只填 `1:1` / `1:N` / `N:1` / `N:N`。

5. **改动作和术语**
   - `actions[].appliesTo` 指向已声明的 type；`requiresRelations` 指向已声明的关系 id。
   - `glossary[].objectId` 必须指向已存在的对象。
   - 术语只收主人真实在用的叫法，不要自造。

6. **验证**
   - `map index` 能读出类型/关系/对象数量。
   - `map show <id>` 能看到刚加的边；`map path` / `map impact` 能跑。
   - 在仓库 `app/` 下跑：`node --import tsx --test test/business-map.test.ts`。
   - 校验失败时按报错改源文件；`BusinessMapError` 会指出文件名和字段。
   - 限制：单文件 ≤512KB；对象 ≤2000；关系 ≤200；每条关系边 ≤5000。

7. **汇报**
   - 改了哪些文件；新增/修改了哪些 id；每条的依据（文件 + 片段）；`map impact` 结果；测试结果；还没坐实的「待确认」。

## 最小示例

对象：

```json
{
  "id": "service:rabbit-bot-api",
  "type": "service",
  "name": "api",
  "aliases": ["REST API"],
  "description": "rabbit-bot 的本地 REST API",
  "source": { "kind": "path", "value": "app/src" }
}
```

手动关系：

```json
{
  "id": "service_belongs_to_project",
  "name": "belongs_to",
  "fromType": "service",
  "toType": "project",
  "mapping": {
    "kind": "manual",
    "edges": [{ "from": "service:rabbit-bot-api", "to": "project:rabbit-bot" }]
  },
  "cardinality": "N:1",
  "risk": "low",
  "semantics": "服务属于哪个项目"
}
```

文件映射关系：

```json
{
  "id": "service_deploys_to_env",
  "name": "deploys_to",
  "fromType": "service",
  "toType": "env",
  "mapping": { "kind": "file", "file": "deploy/{env}.json", "select": "services[]" },
  "cardinality": "N:N",
  "risk": "high",
  "semantics": "服务当前部署在哪些环境；改服务前先看影响面"
}
```

`deploy/prod.json`：

```json
{ "services": ["rabbit-bot-api", "rabbit-bot-admin"] }
```

文件映射的 `services[]` 会用 id / `key.value` / `name` / slug / aliases 去匹配 `fromType` 的对象，大小写不敏感。

## 常见坑

- 先建关系再建对象：会报「边引用了不存在的对象」。
- `fromType` / `toType` 没在 `types` 里声明：先补 type。
- `file` 映射的 `select` 写错或文件不存在：不报错，但边是空的；用 `map show` / `map path` 确认。
- JSON 里写注释：不是合法 JSON，直接报错。
- 为了省事复制一个对象、只改别名：先查重，能加 alias 就不要新建。
- 把部署文件当 schema 改：`deploy/` 只放真实部署事实，不写推断。
- 把 token、密码、密钥写进 `source` 或 `description`：一律不要。

## 参考

- 字段和限制：`../_shared/business-map-schema.md`
- 设计文档：`docs/PLAN-BUSINESS-MAP.md`
- 最小示例：`docs/examples/business/`
