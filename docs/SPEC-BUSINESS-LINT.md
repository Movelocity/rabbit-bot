# 业务地图 lint（只读异常报告）

> 状态：已实现。**不后台自动跑**，由 UFA 主动调用或 Web 手动触发。
> 2026-11-11

## 目的

业务地图的边是显式写入的，不会自动算。这个 lint 把「只建了关系没写边」「边没证据」「高风险关系没语义」「别名重名」「悬空引用」之类的问题报出来，**只读，不改地图**。

## 入口

| 入口 | 用法 |
|---|---|
| UFA 工具 | `map` action=`lint` |
| HTTP | `GET /v1/business/lint` |
| Web | 知识页「检查异常」按钮 |
| 报告文件 | `~/.config/rabbit-bot/runtime/business-lint.json` |

HTTP 返回：

```json
{
  "checked_at": 1794...,
  "exists": true,
  "version": 3,
  "counts": { "types": 5, "objects": 59, "relations": 4, "edges": 62, "actions": 1, "terms": 1 },
  "findings": [{ "level": "warn", "code": "relation.no_edges", "message": "...", "ref": "..." }],
  "summary": { "error": 0, "warn": 3, "info": 6 }
}
```

## 检查项

- `edge.relation_missing` / `edge.from_missing` / `edge.to_missing`：悬空引用（error）
- `object.type_missing` / `relation.from_type_missing` / `relation.to_type_missing`：类型未声明（error）
- `term.object_missing`：术语指向不存在的对象（error）
- `action.type_missing` / `action.relation_missing`：动作引用不存在（error）
- `relation.no_edges`：关系没有任何实例边（warn）
- `edge.no_evidence`：边没写 evidence（warn）
- `relation.high_no_semantics`：高风险关系没写 semantics（warn）
- `object.duplicate_name` / `object.duplicate_alias`：重名，resolve 会多候选（warn）
- `object.isolated` / `type.empty` / `object.no_key` / `relation.no_cardinality` / `relation.no_direction`（info）
- `map.empty`：还没有业务地图（info）

## 主动用法

没有后台定时任务。UFA 在以下时机主动读 `skills/ufa-maintenance/SKILL.md` 并执行：

- 用户说「整理一下」「检查记忆和关系」；
- 刚结束一段重要对话；
- 发现记忆互相矛盾或明显过时。

UFA 只报告异常；要改业务地图，建任务交给 WA（先 `GET /v1/business`，改完 `PUT`，边带 evidence）。UFA 不直接写地图。
