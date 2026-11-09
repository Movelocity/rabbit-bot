# 技能（skills）

一个技能一个目录，**设计进 git，运行时进 data/**：

```
skills/<name>/
  SKILL.md          # 设计：什么时候用、怎么做。进 git
  ...               # 模板、脚本等设计资产。进 git
  data/             # 运行时产物：缓存、下载、中间结果。不进 git
```

- 宿主路径：`app/data/sandbox/skills/<name>/`
- 容器路径：`/work/skills/<name>/`（`data/sandbox` 整个挂成 `/work`）
- `data/` 由宿主启动时自动 `mkdir -p`（`src/ops/skills.ts` 的 `ensureSkillDataDirs`），clone 下来不用手工建。
- 以 `_` 开头的目录（如 `_template`）不算技能，不会自动建 data。
- 写运行时文件只写 `data/`；别改 `SKILL.md` 以外的设计文件来存状态。

## 快速索引

容器里直接跑 `skills`（宿主对应 `python3 docker/skills.py`）：

```bash
skills                 # 按「自己的 / 共享库」分组，带一句描述
skills --full          # 不截断描述
skills --paths         # 只输出 SKILL.md 路径
skills --json          # 机器可读
skills 关键词           # 按名字或描述过滤
```

读全文还是 `cat skills/<name>/SKILL.md` 或 `cat shared-skills/<name>/SKILL.md`。

## 技能里怎么访问业务数据

沙盒不挂数据库，走宿主 REST API：

```bash
curl -s -H "Authorization: Bearer $RB_API_TOKEN" "$RB_API_URL/v1/pools"
```

路由见 `docs/sandbox-api.md`。`$RB_API_URL` / `$RB_API_TOKEN` 由宿主自动注入容器。

## 新建一个技能

```bash
cp -R data/sandbox/skills/_template data/sandbox/skills/my-skill
# 改 SKILL.md；重启后 data/ 会自动出现，或者直接 mkdir -p
```
