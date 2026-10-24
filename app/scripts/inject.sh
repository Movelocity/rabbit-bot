#!/usr/bin/env bash
# 本地注入：绕过飞书，直接把一句话塞进池子让 agent 处理。
#   npm run inject -- "在吗" [发送者]
#   sender 默认「大肥鱼」，用来跟主人区分。
# token 从 ~/.config/poolchat/env 读（POOLCHAT_INJECT_TOKEN），不打印。
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${POOLCHAT_ENV_FILE:-$HOME/.config/poolchat/env}"
PORT="${POOLCHAT_INJECT_PORT:-3737}"

MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "用法: npm run inject -- \"要注入的话\" [发送者]" >&2
  exit 64
fi
SENDER="${2:-大肥鱼}"

[ -f "$ENV_FILE" ] || { echo "缺少凭据文件：$ENV_FILE" >&2; exit 2; }
set -a; . "$ENV_FILE"; set +a
[ -n "${POOLCHAT_INJECT_TOKEN:-}" ] || { echo "env 里没有 POOLCHAT_INJECT_TOKEN，服务端会 fail-closed 拒掉" >&2; exit 2; }

BODY=$(MSG="$MSG" SENDER="$SENDER" python3 -c 'import json,os; print(json.dumps({"text": os.environ["MSG"], "sender": os.environ["SENDER"]}, ensure_ascii=False))')

curl -sS -m 10 -X POST "http://127.0.0.1:${PORT}/inject" \
  -H "content-type: application/json" \
  -H "x-poolchat-token: ${POOLCHAT_INJECT_TOKEN}" \
  --data-binary "$BODY"
echo
