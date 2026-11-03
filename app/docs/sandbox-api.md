# 沙盒 REST API

沙盒里的技能脚本不挂数据库、不挂 `scripts/`，要访问池 / 计划 / 记忆 / 沙盒文件，统一走宿主进程的 REST API（`src/api.ts`）。

容器里装了客户端 `/usr/local/bin/rb`（源码 `docker/rb.mjs`），下面这些接口它都有同名命令：
业务数据走 API，`sb list/read/write/run` 直接操作 `/work`。模型和技能脚本用 `rb`，宿主和外部进程用 HTTP。

## 环境变量（由宿主自动注入容器）

| 变量 | 容器里 | host 模式 |
|---|---|---|
| `RB_API_URL` | `http://host.docker.internal:3738` | `http://127.0.0.1:3738` |
| `RB_API_TOKEN` | `data/run/api.token` 的内容（或 `RABBIT_BOT_API_TOKEN`） | 同左 |

token 优先取环境变量 `RABBIT_BOT_API_TOKEN`（≥16 位）；没有就自动生成 32 字节写到 `data/run/api.token`（0600）。token 变了，`ensureSandboxContainer()` 会重建容器，把新值注入进去。

手动拿 token：

```bash
cat data/run/api.token
```

## 调用约定

- 鉴权：`Authorization: Bearer <token>` 或 `x-rabbit-bot-token: <token>`。
- 返回体固定 `{"ok":true,"data":…}` / `{"ok":false,"error":"…"}`，和 CLI 的 JSON 一致。
- 校验失败返回 400，路由不存在 404，token 不对 401。
- `GET /health` 不需要 token（只回状态，不含业务数据）。

```bash
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_URL/v1/pools"
```

## 路由

| 方法 | 路径 | 对应 rb 命令 |
|---|---|---|
| GET | `/health` | — |
| GET | `/v1/pools` | `pool-list` |
| GET | `/v1/pools/:ref/messages?limit=15&before_seq=300` | `pool-read` |
| GET | `/v1/pools/:ref/search?q=火锅&limit=15` | `pool-search` |
| GET | `/v1/plans?status=pending` | `plan-list` |
| POST | `/v1/plans` `{title,kind,when,pool,anchor,why,expires}` | `plan-add` |
| PATCH | `/v1/plans/:id` `{status}` | `plan-update` |
| GET | `/v1/memories?user=u1&pool=p1&limit=20` | `mem-search` |
| POST | `/v1/memories` `{user,content,pool,kind,scope,from,until,supersede}` | `mem-add`（**只给运维**）|
| GET | `/v1/images?source=media\|inbox\|all&page=1&size=20` | `img-list` |
| GET | `/v1/images/file?path=media/x.jpg` | `img-get`（下载到 /work） |
| GET | `/v1/web/search?q=…&count=6&content=1` | `web-search` |
| POST | `/v1/web/fetch` `{url}` | `web-fetch` |
| GET | `/v1/skills` | —（技能发现：名字、SKILL.md、data 路径） |
| GET | `/v1/sandbox/files?path=notes` | `sb list` |
| GET | `/v1/sandbox/file?path=notes/todo.md` | `sb read` |
| PUT | `/v1/sandbox/file?path=notes/todo.md` `{content}` | `sb write` |

`sb run` 不开放：技能脚本本来就在 shell 里，再开一层只会递归。

## 技能目录约定

技能不是接口，是给模型读的文件；接口只负责发现和提供业务数据。

```
skills/<name>/
  SKILL.md   # 设计：进 git
  ...        # 模板/脚本等设计资产：进 git
  data/      # 运行时产物：.gitignore 忽略，容器里可写
```

- 宿主：`app/data/sandbox/skills/<name>/`；容器：`/work/skills/<name>/`。
- `data/` 空目录进不了 git，宿主启动和每次 `sb run` 前会 `mkdir -p`（`src/ops/skills.ts`）。
- 以 `_` 或 `.` 开头的目录不算技能（`_template` 是模板），`GET /v1/skills` 不会列出来。
- 新建：`cp -R data/sandbox/skills/_template data/sandbox/skills/my-skill`，再改 `SKILL.md`。

## 安全

- 默认绑 `0.0.0.0`（`config.api.host`），因为 Docker 容器要通过 `host.docker.internal` 连进来；局域网可访问，**全靠 Bearer token**。想只给容器用，把 `host` 改成 docker 网关地址并单独给宿主留 `127.0.0.1` 的入口。
- token 不对的请求只回 401，不泄露路由是否存在。
- 沙盒文件路径走 `createSandboxFs`，`../` 和符号链逃逸一律 400；图片走 `data/media|inbox` 白名单。
- API 不返回飞书 / LLM 密钥；联网能力只代理 DeepSeek 的 search/fetch。

## 本地验证

```bash
npm run doctor                       # 看 mode 和 API 端口
curl -s localhost:3738/health
TOKEN=$(cat data/run/api.token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:3738/v1/pools
npm run sbx -- status                # 容器里是否拿到了 RB_API_URL / RB_API_TOKEN
```

## 写入命令只给运维

模型侧不再用 `rb` 做写入：记忆走 `memory` 工具、计划走 `plan` 工具、文件走
`read_file` / `write_file`。`rb mem-add` / `mem-close` / `plan-add` / `plan-update` / `sb`
在 Agent 的工具层会被挡住，返回「改用 X」——留在 CLI 里是为了人和运维脚本能用。
