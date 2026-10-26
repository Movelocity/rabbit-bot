#!/usr/bin/env bash
# rabbit-bot 前台启动。pm2 的 ecosystem.config.cjs 调的就是 `run.sh fg`。
# 只干三件事：读凭据 → 预检 → exec node。进程托管交给 pm2，
# 别再手工跑第二份——两个进程会抢同一条飞书消息（见 docs/NOTES.md）。
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${RABBIT_BOT_ENV_FILE:-$HOME/.config/rabbit-bot/env}"

# pi 要求 Node >= 22.19；本机装在 ~/.local/node22 时优先用它
[ -x "$HOME/.local/node22/bin/node" ] && export PATH="$HOME/.local/node22/bin:$PATH"
mkdir -p "$APP_DIR/logs"

load_env() { if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi; }

preflight() {
  load_env
  local miss=()
  for v in FEISHU_APP_ID FEISHU_APP_SECRET; do [ -n "${!v:-}" ] || miss+=("$v"); done
  if [ ${#miss[@]} -gt 0 ]; then echo "缺少环境变量：${miss[*]}（以及所选 LLM provider 的 API key），不启动。" >&2; exit 2; fi
  [ -f "$APP_DIR/dist/main.js" ] || (cd "$APP_DIR" && npm run build >/dev/null)
}

case "${1:-fg}" in
  fg) preflight; cd "$APP_DIR"; exec node dist/main.js ;;
  logs) tail -n 100 -f "$APP_DIR/logs/app.log" ;;
  *) echo "用法：$0 fg|logs（起停用 pm2，见 docs/OPERATIONS.md）" >&2; exit 64 ;;
esac
