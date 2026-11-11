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

## edges[]

| 字段 | 必填 | 说明 |
|---|---|---|
| `relation` | 是 | 关系 id，必须已声明 |
| `from` | 是 | 起点对象 id，必须已存在 |
| `to` | 是 | 终点对象 id，必须已存在 |
| `evidence` | 否 | 这条边凭什么：文件路径 + 原文片段、命令输出、主人原话 |

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
- 对象的 `type`、关系的 `fromType` / `toType` 必须已声明。
- 每条边的 `relation` / `from` / `to` 必须已存在；同一组 `relation+from+to` 不能重复。
- `cardinality` 只能是 `1:1` / `1:N` / `N:1` / `N:N`。
- `direction` 只能是 `forward` / `both`。
- `actions.appliesTo` 和 `actions.requiresRelations` 只能引用已声明的类型/关系。
- `terms.objectId` 只能引用已有对象。
- `PUT` 是全量替换：先 `GET`，改完再 `PUT`；校验失败时库里保持原样。
