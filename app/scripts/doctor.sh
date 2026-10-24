#!/usr/bin/env bash
# poolchat 体检：一屏看清进程、实例锁、注入口、沙盒容器、最近唤醒、体积。
#   npm run doctor   （或 bash scripts/doctor.sh）
set -uo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "进程"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list 2>/dev/null | grep -E "name|poolchat" || echo "  pm2 里没有 poolchat"
else
  echo "  没有 pm2（用 scripts/run.sh 起？）"
fi
NODE_N=$(pgrep -f "dist/main.js" | wc -l | tr -d ' ')
printf '  跑着 dist/main.js 的进程：%s' "$NODE_N"
[ "$NODE_N" -gt 1 ] && printf '  ← 多了！同一时间只能有一个（会抢同一条飞书消息）'
echo

say "单实例锁"
if [ -f data/run/main.pid ]; then
  P=$(cat data/run/main.pid 2>/dev/null)
  if kill -0 "$P" 2>/dev/null; then echo "  main.pid=$P 活着 ✓"; else echo "  main.pid=$P 已死（残留，删掉即可）"; fi
else
  echo "  data/run/main.pid 不存在（进程没起来，或者刚起）"
fi

say "本地注入口"
# 用监听表探，不发请求——空 POST 会在服务端记一条「token 不对」的 WARN
if lsof -nP -iTCP:"${POOLCHAT_INJECT_PORT:-3737}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  127.0.0.1:${POOLCHAT_INJECT_PORT:-3737} 在听 ✓（发消息用 npm run inject -- \"...\"）"
else
  echo "  没在听（进程没起？）"
fi

say "沙盒容器"
docker inspect -f '  {{.State.Status}} | 镜像 {{.Config.Image}} | 网络 {{.HostConfig.NetworkMode}} | 内存 {{.HostConfig.Memory}}' poolchat-sbx 2>/dev/null ||
  echo "  容器不存在（下次 sandbox_run 会按 config.sandbox.shell 自建）"

say "最近 24h 唤醒"
node --input-type=module -e '
import Database from "better-sqlite3";
const db = new Database("data/poolchat.db", { readonly: true });
const since = Date.now() - 24 * 3600 * 1000;
const rows = db.prepare("select ts, json from wake_log where ts > ? order by id desc").all(since);
const h = {};
for (const r of rows) { const j = JSON.parse(r.json); const k = `${j.type ?? "?"}/${j.outcome ?? "?"}`; h[k] = (h[k] ?? 0) + 1; }
const detail = Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  ");
console.log(`  ${rows.length} 次  ${detail}`);
' 2>/dev/null || echo "  读不到（db 不存在？）"

say "体积"
du -sh data logs 2>/dev/null | sed 's/^/  /'
printf '  data/media: %s 个文件, data/sandbox: %s 个文件\n' \
  "$(find data/media -type f 2>/dev/null | wc -l | tr -d ' ')" \
  "$(find data/sandbox -type f 2>/dev/null | wc -l | tr -d ' ')"

say "日志末尾"
tail -3 logs/app.log 2>/dev/null | sed 's/^/  /' || echo "  （没有 logs/app.log）"
