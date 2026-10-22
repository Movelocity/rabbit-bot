#!/usr/bin/env bash
# poolchat 常驻运行脚本（本机无 systemd/pm2，用 nohup + 守护循环 + pidfile）。
#   scripts/run.sh start|stop|restart|status|logs|fg
# 密钥只从环境变量读取。可选：把 export 语句放在 ~/.config/poolchat/env（chmod 600，仓库外），本脚本启动时会 source 它。
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_DIR="$APP_DIR/data/run"
PIDFILE="$RUN_DIR/supervisor.pid"
LOG="$APP_DIR/logs/stdout.log"
ENV_FILE="${POOLCHAT_ENV_FILE:-$HOME/.config/poolchat/env}"
# 需要 Node >= 22.19（pi 的要求）；优先用本机安装在 ~/.local/node22 的版本
[ -x "$HOME/.local/node22/bin/node" ] && export PATH="$HOME/.local/node22/bin:$PATH"
mkdir -p "$RUN_DIR" "$APP_DIR/logs"

load_env() { if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi; }

preflight() {
  load_env
  local miss=()
  for v in FEISHU_APP_ID FEISHU_APP_SECRET; do [ -n "${!v:-}" ] || miss+=("$v"); done
  if [ ${#miss[@]} -gt 0 ]; then echo "缺少环境变量：${miss[*]}（以及所选 LLM provider 的 API key），不启动。" >&2; exit 2; fi
  [ -f "$APP_DIR/dist/main.js" ] || (cd "$APP_DIR" && npm run build >/dev/null)
}

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

supervise() {
  # 崩溃自动重启（退避 5s→最多 300s）；退出码 2 = 配置/凭据问题，不重启
  local backoff=5
  while true; do
    local t0=$(date +%s)
    set +e; node "$APP_DIR/dist/main.js"; local code=$?; set -e
    echo "$(date '+%F %T %z') main 退出 code=$code" >> "$LOG"
    [ "$code" = 2 ] && { echo "配置/凭据问题，停止守护" >> "$LOG"; break; }
    [ -f "$RUN_DIR/stop" ] && break
    [ $(( $(date +%s) - t0 )) -gt 600 ] && backoff=5
    sleep "$backoff"; backoff=$(( backoff * 2 > 300 ? 300 : backoff * 2 ))
  done
  rm -f "$PIDFILE"
}

case "${1:-}" in
  start)
    if is_running; then echo "已在运行 (pid $(cat "$PIDFILE"))"; exit 0; fi
    preflight; rm -f "$RUN_DIR/stop"
    cd "$APP_DIR"
    nohup bash "$0" _supervise >> "$LOG" 2>&1 &
    echo $! > "$PIDFILE"; echo "已启动 (supervisor pid $!)，日志：$LOG" ;;
  _supervise) supervise ;;
  fg) preflight; cd "$APP_DIR"; exec node dist/main.js ;;
  stop)
    touch "$RUN_DIR/stop"
    if is_running; then
      sup=$(cat "$PIDFILE")
      pkill -TERM -P "$sup" 2>/dev/null || true   # 先停 node（优雅退出，等当前唤醒结束）
      for _ in $(seq 1 35); do pgrep -P "$sup" >/dev/null || break; sleep 1; done
      kill "$sup" 2>/dev/null || true; rm -f "$PIDFILE"; echo "已停止"
    else echo "未运行"; fi ;;
  restart) "$0" stop; sleep 1; "$0" start ;;
  status) if is_running; then echo "运行中 (supervisor pid $(cat "$PIDFILE"))"; else echo "未运行"; fi
          (cd "$APP_DIR" && node dist/ctl.js status 2>/dev/null) || true ;;
  logs) tail -n 100 -f "$APP_DIR/logs/app.log" ;;
  *) echo "用法：$0 start|stop|restart|status|logs|fg"; exit 1 ;;
esac
