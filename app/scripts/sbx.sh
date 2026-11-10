#!/usr/bin/env bash
# 沙盒容器管理（sb run 背后那个 Docker 容器）。
#   npm run sbx -- status      看状态和边界参数
#   npm run sbx -- start       按 config.exec.shell 起容器（已存在就启动）
#   npm run sbx -- shell       进容器逛（工作目录 /work）
#   npm run sbx -- rebuild     按 config.exec.shell 重建（先删再让下次 sb run 自建）
#   npm run sbx -- image       重建镜像（改过 docker/sandbox.Dockerfile 之后跑）
#   npm run sbx -- clean       清空 /work 里的东西（沙盒根 = 运行时目录，会二次确认）
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
NAME="rabbit-bot-sbx"
IMAGE="rabbit-bot-sandbox:latest"

# 沙盒根（宿主侧）：exec.dir 留空时就是运行时目录
EXEC_DIR=$(npx tsx -e 'import { loadConfig } from "./src/config.ts"; console.log(loadConfig({}).exec.dir)' 2>/dev/null || true)
if [ -z "$EXEC_DIR" ]; then
  echo "读不到 exec.dir（先在 app/ 下 npm install）" >&2
  exit 2
fi

case "${1:-status}" in
  status)
    MODE=$(npx tsx -e 'import { loadConfig } from "./src/config.ts"; const s = loadConfig({}).exec.shell; console.log(s.enabled ? s.mode : "off")' 2>/dev/null || echo "读取失败")
    echo "配置 mode: $MODE"
    echo "沙盒根: $EXEC_DIR"
    if [ "$MODE" = "host" ]; then
      echo "  ⚠ host 模式：命令直接跑在宿主机上，下面的容器参数不生效（仅本地开发用）"
    fi
    docker inspect -f '状态 {{.State.Status}}
镜像 {{.Config.Image}}
网络 {{.HostConfig.NetworkMode}}
根只读 {{.HostConfig.ReadonlyRootfs}}
内存 {{.HostConfig.Memory}} 字节
进程上限 {{.HostConfig.PidsLimit}}
重启策略 {{.HostConfig.RestartPolicy.Name}}' "$NAME" 2>/dev/null || echo "容器不存在（下次 sb run 会自建）"
    if docker inspect "$NAME" >/dev/null 2>&1; then
      ENVS=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME")
      printf '%s\n' "$ENVS" | grep -q '^RB_API_URL=' && echo "RB_API_URL 已注入 ✓" || echo "RB_API_URL 缺失（重建容器：npm run sbx -- rebuild）"
      printf '%s\n' "$ENVS" | grep -q '^RB_API_TOKEN=' && echo "RB_API_TOKEN 已注入 ✓（不打印内容）" || echo "RB_API_TOKEN 缺失（重建容器：npm run sbx -- rebuild）"
    fi
    echo "--- /work 里的东西 ---"
    ls -la "$EXEC_DIR" 2>/dev/null | sed 's/^/  /'
    ;;
  shell)
    docker exec -it "$NAME" sh -lc 'cd /work && exec sh'
    ;;
  start)
    npx tsx -e 'import { loadConfig } from "./src/config.ts"; import { shellRunnerOptions } from "./src/ops/exec.ts"; import { ensureSandboxContainer } from "./src/core/shell-runner.ts"; (async () => { const cfg = loadConfig({}); const r = await ensureSandboxContainer(shellRunnerOptions(cfg)); console.log(`容器：${r.message}`); process.exit(r.ok ? 0 : 1); })()'
    ;;
  rebuild)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "已删除，下次 sb run 会按 config 重建" || echo "本来就不存在"
    ;;
  image)
    docker build -t "$IMAGE" -f docker/sandbox.Dockerfile docker/ && echo "镜像已重建：${IMAGE}（容器下次重建才会用上）"
    ;;
  clean)
    echo "将清空 $EXEC_DIR 下的 shared/ 和 files/（不动 persona/prompt/topics）。"
    read -r -p "确认？输入 yes：" ans
    if [ "$ans" = "yes" ]; then rm -rf "${EXEC_DIR:?}/shared"/* "${EXEC_DIR:?}/files"/* 2>/dev/null; echo "已清空"; else echo "取消"; fi
    ;;
  *)
    echo "用法: npm run sbx -- status|start|shell|rebuild|image|clean" >&2
    exit 64
    ;;
esac
