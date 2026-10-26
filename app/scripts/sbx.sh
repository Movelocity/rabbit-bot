#!/usr/bin/env bash
# 沙盒容器管理（sandbox_run 背后那个 Docker 容器）。
#   npm run sbx -- status      看状态和边界参数
#   npm run sbx -- shell       进容器逛（工作目录 /work）
#   npm run sbx -- rebuild     按 config.sandbox.shell 重建（先删再让下次 sandbox_run 自建）
#   npm run sbx -- image       重建镜像（改过 docker/sandbox.Dockerfile 之后跑）
#   npm run sbx -- clean       清空 /work 里的东西（沙盒目录 data/sandbox，会二次确认）
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
NAME="rabbit-bot-sbx"
IMAGE="rabbit-bot-sandbox:latest"

case "${1:-status}" in
  status)
    docker inspect -f '状态 {{.State.Status}}
镜像 {{.Config.Image}}
网络 {{.HostConfig.NetworkMode}}
根只读 {{.HostConfig.ReadonlyRootfs}}
内存 {{.HostConfig.Memory}} 字节
进程上限 {{.HostConfig.PidsLimit}}
重启策略 {{.HostConfig.RestartPolicy.Name}}' "$NAME" 2>/dev/null || echo "容器不存在（下次 sandbox_run 会自建）"
    echo "--- /work 里的东西 ---"
    ls -la data/sandbox 2>/dev/null | sed 's/^/  /'
    ;;
  shell)
    docker exec -it "$NAME" sh -lc 'cd /work && exec sh'
    ;;
  rebuild)
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "已删除，下次 sandbox_run 会按 config 重建" || echo "本来就不存在"
    ;;
  image)
    docker build -t "$IMAGE" -f docker/sandbox.Dockerfile docker/ && echo "镜像已重建：$IMAGE（容器下次重建才会用上）"
    ;;
  clean)
    echo "将清空 $APP_DIR/data/sandbox 下的全部内容。"
    read -r -p "确认？输入 yes：" ans
    [ "$ans" = "yes" ] && rm -rf "${APP_DIR:?}/data/sandbox"/* && echo "已清空" || echo "取消"
    ;;
  *)
    echo "用法: npm run sbx -- status|shell|rebuild|image|clean" >&2
    exit 64
    ;;
esac
