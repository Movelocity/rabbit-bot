#!/usr/bin/env bash
# 本地注入：绕过飞书，直接把一句话塞进池子让 agent 处理。
#   npm run inject -- "在吗" [发送者]
#   sender 默认「大肥鱼」，用来跟主人区分。
# token 从 ~/.config/rabbit-bot/env 读（RABBIT_BOT_INJECT_TOKEN），不打印。
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${RABBIT_BOT_ENV_FILE:-$HOME/.config/rabbit-bot/env}"
PORT="${RABBIT_BOT_INJECT_PORT:-3737}"

MSG="${1:-}"
# 用法：npm run inject -- "话" [发送者]；测试请加 INJECT_POOL=mock:test
if [ -z "$MSG" ]; then
  echo "用法: npm run inject -- \"要注入的话\" [发送者]" >&2
  exit 64
fi
SENDER="${2:-大肥鱼}"

[ -f "$ENV_FILE" ] || { echo "缺少凭据文件：$ENV_FILE" >&2; exit 2; }
set -a; . "$ENV_FILE"; set +a
[ -n "${RABBIT_BOT_INJECT_TOKEN:-}" ] || { echo "env 里没有 RABBIT_BOT_INJECT_TOKEN，服务端会 fail-closed 拒掉" >&2; exit 2; }

# INJECT_POOL=mock:test 可以把消息注进测试池，她的回复只会落在 mock adapter 里，
# 不会发到真实飞书。不设就还是第一个池（真实私聊）——测试时务必设。
BODY=$(MSG="$MSG" SENDER="$SENDER" POOL="${INJECT_POOL:-}" python3 -c '
import json, os
d = {"text": os.environ["MSG"], "sender": os.environ["SENDER"]}
if os.environ.get("POOL"): d["pool"] = os.environ["POOL"]
print(json.dumps(d, ensure_ascii=False))')

curl -sS -m 10 -X POST "http://127.0.0.1:${PORT}/inject" \
  -H "content-type: application/json" \
  -H "x-rabbit-bot-token: ${RABBIT_BOT_INJECT_TOKEN}" \
  --data-binary "$BODY"
echo
