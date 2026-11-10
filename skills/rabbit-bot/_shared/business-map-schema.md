# 业务地图字段与校验

业务地图目录：`<runtime>/business/`。所有文件都是严格 JSON，不支持注释。

## objects.json（必填）

```json
{
  "version": 1,
  "types": [],
  "objects": []
}
```

`types[]`：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 类型 id，例如 `project` / `repo` / `service` / `env` / `person` |
| `name` | 否 | 展示名 |
| `description` | 否 | 一句话说明 |

`objects[]`：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 建议 `type:slug`，全局唯一 |
| `type` | 是 | 必须在 `types[].id` 里声明 |
| `name` | 是 | 对象名 |
| `aliases` | 否 | 真实叫法，最多 50 个 |
| `description` | 否 | 一句话说明 |
| `key` | 否 | `{ "kind": "...", "value": "..." }`，用于 file 映射匹配 |
| `source` | 否 | `{ "kind": "path", "value": "..." }`，写依据的位置 |
| `tags` | 否 | 标签，最多 50 个 |

## relations.json（可选）

```json
{
  "version": 1,
  "relations": []
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 关系 id，全局唯一 |
| `name` | 是 | 关系动词，例如 `belongs_to` / `deploys_to` |
| `fromType` | 是 | 必须在 `types[].id` 里声明 |
| `toType` | 是 | 必须在 `types[].id` 里声明 |
| `kind` | 否 | `manual` 或 `file`；默认取 `mapping.kind` |
| `mapping.kind` | 是 | `manual` 或 `file` |
| `mapping.edges` | manual 必填 | `[{ "from": "对象id", "to": "对象id" }]`，两端都必须是已有对象 |
| `mapping.file` | file 必填 | 相对 business 目录的数据文件 |
| `mapping.select` | 否 | 从数据文件里取值的点路径；数组写 `[]`，例如 `services[]` |
| `cardinality` | 否 | `1:1` / `1:N` / `N:1` / `N:N` |
| `direction` | 否 | `forward` 或 `both`，默认 `forward` |
| `risk` | 否 | `low` / `medium` / `high`；high 建议写 `semantics` |
| `semantics` | 否 | 这条关系在实际业务里是什么意思 |

### file 映射

`mapping.file` 会按目标对象（`toType` 的每个对象）展开：

| 占位符 | 取值 |
|---|---|
| `{id}` | 对象 id |
| `{type}` | 对象 type |
| `{name}` | 对象 name |
| `{slug}` | id 冒号后的部分 |
| `{key}` | `key.value`；没有就用 slug |

例：`deploy/{env}.json` 会为每个 env 对象读 `deploy/prod.json`、`deploy/staging.json` 等。

`mapping.select` 按点路径取值，数组用 `[]`。取出来的值会去匹配 `fromType` 对象的 `id` / `key.value` / `name` / slug / aliases，大小写不敏感。

## actions.json（可选）

```json
{
  "version": 1,
  "actions": []
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 动作 id |
| `name` | 否 | 展示名 |
| `appliesTo` | 否 | 类型 id 数组，必须已声明 |
| `risk` | 否 | `low` / `medium` / `high` |
| `requiresRelations` | 否 | 关系 id 数组，必须已声明 |
| `description` | 否 | 一句话说明 |

## glossary.json（可选）

```json
{
  "version": 1,
  "terms": []
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `term` | 是 | 主人真实在用的说法 |
| `objectId` | 是 | 必须指向已有对象 |
| `note` | 否 | 备注 |

## 校验与限制

- `version` 必须是 `1`。
- 对象 id、类型 id、关系 id 不能重复。
- 对象的 `type`、关系的 `fromType` / `toType` 必须已声明。
- manual 关系至少要有一条边；边两端必须是已有对象。
- file 关系必须有 `mapping.file`。
- `cardinality` 只能是 `1:1` / `1:N` / `N:1` / `N:N`。
- `direction` 只能是 `forward` / `both`。
- `actions.appliesTo` 和 `actions.requiresRelations` 只能引用已声明的类型/关系。
- `glossary.objectId` 只能引用已有对象。
- 单文件 ≤512KB；对象 ≤2000；关系 ≤200；每条关系解析出的边 ≤5000。
- 文件不存在、JSON 不合法、字段缺失都会抛出 `BusinessMapError`，报错里带文件名和字段位置。

## 改完怎么验

```bash
# 在仓库的 app/ 下
node --import tsx --test test/business-map.test.ts
```

再用 `map` 工具确认：

- `map index`：类型/关系/对象数量
- `map show <id>`：对象和直接关系
- `map path <from> <to>`：关系路径
- `map impact <id>`：改这个对象会影响谁
