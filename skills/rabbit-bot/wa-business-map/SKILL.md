---
name: rabbit-bot-wa-business-map
description: WA 侧业务地图维护：通过 /v1/business API 读取和全量写入对象/关系/边/动作/术语，要求每条有证据、不猜关系，改完用 GET 和测试验证。当 WA 接到业务关系入库、对象/关系修改、部署映射、影响面分析任务时使用。
---

# WA：业务地图维护

WA 是编辑者。只改有证据的东西；没有依据的进「待确认」，不要替主人补。

## 存在哪、谁写

- 业务地图存在 **SQLite**（`rabbit-bot.db` 的 `business_*` 表），运行时只读它。
- **WA 写**：调 `PUT $RB_API_BASE/v1/business` 全量替换。
- **UFA 只读**：UFA 用 `map` 工具查，不写；改动由 UFA 建任务交给你。
- **人拍板**：谁属于谁、谁部署到哪、谁负责，最终由主人确认。
- 鉴权：所有请求带 `Authorization: Bearer $RB_API_TOKEN`。

旧的 `runtime/business/*.json` 只在第一次启动时导入一次；之后改文件不会生效，别再用 `write_file` 改它。

## 读写 API

```bash
# 读当前快照
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_BASE/v1/business"

# 全量写回（body 是下面这种快照）
curl -s -X PUT "$RB_API_BASE/v1/business" \
  -H "Authorization: Bearer $RB_API_TOKEN" \
  -H "content-type: application/json" \
  --data @snapshot.json
```

快照字段：

```json
{
  "version": 1,
  "types": [{ "id": "service", "name": "服务" }],
  "objects": [{
    "id": "service:rabbit-bot-api", "type": "service", "name": "api",
    "description": "本地 REST API", "aliases": ["REST API"],
    "source": { "kind": "path", "value": "app/src" }
  }],
  "relations": [{
    "id": "service_deploys_to_env", "name": "deploys_to",
    "fromType": "service", "toType": "env",
    "cardinality": "N:N", "direction": "forward", "risk": "high",
    "semantics": "服务当前部署在哪些环境"
  }],
  "edges": [
    { "relation": "service_deploys_to_env", "from": "service:rabbit-bot-api", "to": "env:prod",
      "evidence": "deploy/prod.json 原文：services 含 rabbit-bot-api" }
  ],
  "actions": [{ "id": "deploy", "name": "发布", "appliesTo": ["service"], "risk": "high", "requiresRelations": ["service_deploys_to_env"] }],
  "terms": [{ "term": "管理后台", "objectId": "service:rabbit-bot-admin" }]
}
```

字段级说明见 `../_shared/business-map-schema.md`。

## 维护流程

1. **先读现状**：`GET /v1/business` 拉全量。PUT 是全量替换，漏掉的数组会被清空——**先 GET，再改，再 PUT**。
2. **查重**：按 id、`key.value`、`name`、`aliases` 查。能加 alias 就不要新建对象。
3. **找证据**：每个新增/修改都要能指到来源（文件路径+原文、命令输出、主人原话）。找不到来源的列进「待确认」，不要写进正式地图。不要猜负责人、部署环境、服务归属。
4. **改对象**：`id` 用 `type:slug`（如 `service:rabbit-bot-api`）；`type` 必须已在 `types` 里；`name` 必填；`aliases` 只收真实叫法；`source` 写依据位置。
5. **改关系**：`id` 稳定，`name` 是关系动词（`belongs_to` / `deploys_to` / `owns`）；`fromType` / `toType` 必须已声明；`risk=high` 要写 `semantics`。
6. **写边**：每条实例进 `edges`，`from` / `to` 必须是已有对象 id；能写 `evidence` 就写。关系本身不产生边，边必须显式给。
7. **验证**：PUT 成功后重新 GET，确认 `objects` / `relations` / `edge_total` 和 `map show/path/impact` 一致；在仓库 `app/` 下跑 `node --import tsx --test test/business-map.test.ts`。
8. **汇报**：改了哪些 id；每条的依据（文件+片段）；影响面；测试结果；还没坐实的「待确认」。

## 常见坑

- PUT 前没 GET：整个地图被清空或丢关系。
- 先建边后建对象：报 `edges[i] 的 from/to 不存在`。
- `fromType` / `toType` 没在 `types` 里声明：先补 type。
- 关系建了但没写 `edges`：`map show` 看不到实例，`impact` 也算不出。
- 为了省事复制对象、只改别名：先查重。
- 把 token、密码、密钥写进 `source` 或 `description`：一律不要。

## 参考

- 字段和限制：`../_shared/business-map-schema.md`
- 设计文档：`docs/PLAN-BUSINESS-MAP.md`
- 最小示例：`docs/examples/business/`
