# 业务地图字段与校验

业务地图存在 SQLite 的 `business_*` 表里；读写都走 `/v1/business`：
`GET` 拉全量快照，`PUT` 全量替换。`runtime/business/*.json` 只在第一次启动时导入一次，之后不再读。

## 快照顶层

```json
{
  "version": 1,
  "types": [],
  "objects": [],
  "relations": [],
  "edges": [],
  "actions": [],
  "terms": []
}
```

## types[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 类型 id，例如 `project` / `repo` / `service` / `env` / `person` |
| `name` | 否 | 展示名 |
| `description` | 否 | 一句话说明 |

## objects[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 建议 `type:slug`，全局唯一 |
| `type` | 是 | 必须在 `types[].id` 里声明 |
| `name` | 是 | 对象名 |
| `aliases` | 否 | 真实叫法，最多 50 个 |
| `description` | 否 | 一句话说明 |
| `key` | 否 | `{ "kind": "...", "value": "..." }`，用于匹配/去重 |
| `source` | 否 | `{ "kind": "path", "value": "..." }`，写依据的位置 |
| `tags` | 否 | 标签，最多 50 个 |
| `graph_id` | 否 | 所属图谱名，字符串，默认 `default`；空/不传都落默认图谱 |
| `import_batch` | 否 | 导入批次号，字符串，默认空串；只是来源标记，不参与关系计算 |

## relations[]

关系只声明类型和语义，**实例在 edges 里**。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 关系 id，全局唯一 |
| `name` | 是 | 关系动词，例如 `belongs_to` / `deploys_to` |
| `fromType` | 是 | 必须在 `types[].id` 里声明 |
| `toType` | 是 | 必须在 `types[].id` 里声明 |
| `cardinality` | 否 | `1:1` / `1:N` / `N:1` / `N:N` |
| `direction` | 否 | `forward` 或 `both`，默认 `forward` |
| `risk` | 否 | `low` / `medium` / `high`；high 建议写 `semantics` |
| `semantics` | 否 | 这条关系在实际业务里是什么意思 |
| `graph_id` | 否 | 所属图谱名，默认 `default`；边只能连同一图谱的对象 |
| `import_batch` | 否 | 导入批次号，默认空串；不传时边继承关系的批次 |

## edges[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `relation` | 是 | 关系 id，必须已声明 |
| `from` | 是 | 起点对象 id，必须已存在 |
| `to` | 是 | 终点对象 id，必须已存在 |
| `evidence` | 否 | 这条边凭什么：文件路径 + 原文片段、命令输出、主人原话 |
| `graph_id` | 否 | 所属图谱名，默认继承关系的 `graph_id`；显式传就必须和关系、两端对象一致 |
| `import_batch` | 否 | 导入批次号，默认继承关系的 `import_batch` |

`GET /v1/business` 返回的 `edges[]` 也带 `evidence`，全量写回时原样保留。

## actions[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 动作 id |
| `name` | 否 | 展示名 |
| `appliesTo` | 否 | 类型 id 数组，必须已声明 |
| `risk` | 否 | `low` / `medium` / `high` |
| `requiresRelations` | 否 | 关系 id 数组，必须已声明 |
| `description` | 否 | 一句话说明 |

## terms[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `term` | 是 | 主人真实在用的说法 |
| `objectId` | 是 | 必须指向已有对象 |
| `note` | 否 | 备注 |

## 校验与限制

- `version` 必须是正整数。
- 对象 id、类型 id、关系 id 不能重复。
- `graph_id` 是自定义字符串（≤100 字符），空值/不传都落默认图谱 `default`；同一图谱内 id 仍全局唯一。
- `import_batch` 是自定义字符串（≤100 字符），空值/不传落空串；只做来源标记，不影响查询。
- `types` 是全局共享的类型表，不按图谱拆分。
- `edges[].graph_id` 不传时继承关系的图谱；显式传时必须和关系、`from` / `to` 对象的图谱一致，跨图谱连边会被拒绝。
- 对象的 `type`、关系的 `fromType` / `toType` 必须已声明。
- 每条边的 `relation` / `from` / `to` 必须已存在；同一组 `relation+from+to` 不能重复。
- `cardinality` 只能是 `1:1` / `1:N` / `N:1` / `N:N`。
- `direction` 只能是 `forward` / `both`。
- `actions.appliesTo` 和 `actions.requiresRelations` 只能引用已声明的类型/关系。
- `terms.objectId` 只能引用已有对象。
- `PUT` 是全量替换：先 `GET`，改完再 `PUT`；校验失败时库里保持原样。
