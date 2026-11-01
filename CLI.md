# 运维命令 —— 人用的入口

`rb` 现在只活在沙盒容器里（`/usr/local/bin/rb`），是 agent 和技能脚本用的通道：
业务数据走宿主 REST API，文件和 shell 直接操作 `/work`。见 `app/docs/sandbox-api.md`。

宿主上只留运维命令：

| 命令 | 干什么 |
|---|---|
| `node scripts/doctor.sh` / `npm run doctor` | 体检：进程、锁、注入口、沙盒模式与容器、API 端口、唤醒、体积 |
| `npm run sbx -- status\|start\|shell\|rebuild\|image\|clean` | 沙盒容器管理（`start` 见下） |
| `npm run inject -- "..."` | 往本地注入口塞一条消息 |
| `npm run ctl -- <pause\|resume\|status\|usage\|wakes\|plans…>` | 运行时控制 |
| `npm run idle` | 空闲检测 |
| `npm test` / `npm run typecheck` | 测试与类型检查 |

## 沙盒容器

```bash
npm run sbx -- image     # 改过 docker/sandbox.Dockerfile 后重建镜像
npm run sbx -- status    # 状态、边界参数、RB_API_* 是否注入
npm run sbx -- rebuild   # 删容器，下次启动/sb run 按 config 自建
npm run sbx -- clean     # 清空 data/sandbox（会二次确认）
```

`mode=docker`（默认）下宿主启动时会自动建容器；`mode=host` 是本地开发用的无隔离模式，
不给沙盒建容器，命令直接跑在宿主上。切换见 `app/DEPLOY.local.md`。

## 开发/调参脚本

不是 agent 能力，直接用 `npx tsx` 跑：

```bash
npx tsx scripts/sim-energy.ts      # 能量模型推演
npx tsx scripts/wave-check.ts      # 此刻每池水位
npx tsx scripts/wave-obs.ts        # 拿真实库回放
```

## 为什么不是一个万能 CLI

业务脚本已经删了：它们原本只是 `src/ops/` 的薄壳，agent 的入口改成了沙盒里的 `rb`
（一个工具顶掉一堆 schema），宿主的对外集成面改成了 HTTP API。宿主 CLI 只留人真正会
在终端敲的运维动作。
