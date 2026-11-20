#!/usr/bin/env bash
# rabbit-bot 部署确定性检查。只读，不会启动/停止服务。
#
#   bash scripts/deploy-check.sh --layer auto
#   bash scripts/deploy-check.sh --layer web --roundtrip
#   RB_APP_DIR=/path/to/rabbit-bot/app bash scripts/deploy-check.sh --layer production
#
# 输出每行：STATUS<TAB>检查项<TAB>说明
# 退出码：0 = 没有 FAIL；1 = 有 FAIL；2 = 用法错误。
set -uo pipefail

LAYER="auto"
ROUNDTRIP=0
TIMEOUT=120
APP_DIR="${RB_APP_DIR:-}"

usage() {
  cat >&2 <<EOF
用法：$0 [--layer auto|demo|web|feishu|production] [--roundtrip] [--timeout 秒] [--app <app 目录>]
  --layer      检查目标层，默认 auto
  --roundtrip  网页直聊发一句并等自回复（会真实调用一次 LLM）
  --timeout    roundtrip 最长等待秒数，默认 120
  --app        rabbit-bot 的 app 目录；默认取 \$RB_APP_DIR、脚本相对路径或当前目录
EOF
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --layer) [ $# -ge 2 ] || usage; LAYER="$2"; shift 2 ;;
    --roundtrip) ROUNDTRIP=1; shift ;;
    --timeout) [ $# -ge 2 ] || usage; TIMEOUT="$2"; shift 2 ;;
    --app) [ $# -ge 2 ] || usage; APP_DIR="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知参数：$1" >&2; usage ;;
  esac
done

case "$LAYER" in
  auto|demo|web|feishu|production) ;;
  *) echo "不支持的 layer：$LAYER" >&2; usage ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "$APP_DIR" ]; then
  for cand in "$SCRIPT_DIR/../../../../app" "$PWD/app" "$PWD"; do
    if [ -f "$cand/package.json" ] && grep -q '"name": "rabbit-bot"' "$cand/package.json" 2>/dev/null; then
      APP_DIR="$(cd "$cand" && pwd)"; break
    fi
  done
fi
if [ -z "$APP_DIR" ] || [ ! -f "$APP_DIR/package.json" ]; then
  echo -e "FAIL\trepo\t找不到 rabbit-bot 的 app 目录（用 --app 或 RB_APP_DIR 指定）"
  exit 1
fi
APP_DIR="$(cd "$APP_DIR" && pwd)"

PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS\t%s\t%s\n' "$1" "$2"; }
warn() { WARN=$((WARN+1)); printf 'WARN\t%s\t%s\n' "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL\t%s\t%s\n' "$1" "$2"; }
note() { printf 'INFO\t%s\t%s\n' "$1" "$2"; }

ENV_FILE="${RABBIT_BOT_ENV_FILE:-$HOME/.config/rabbit-bot/env}"

env_has() {
  local name="$1"
  if [ -n "${!name:-}" ]; then return 0; fi
  grep -Eq "^${name}=.+" "$ENV_FILE" 2>/dev/null
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || echo ""
}

# ---------- 基础环境 ----------
case "$(uname -s)" in
  Darwin|Linux) ok platform "$(uname -s)" ;;
  *) bad platform "$(uname -s)：Windows 原生不支持，请用 WSL2" ;;
esac

if command -v node >/dev/null 2>&1; then
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then
    ok node "$(node -v)"
  else
    bad node "$(node -v)：需要 >= 22.19"
  fi
else
  bad node "没有 node"
fi

if command -v npm >/dev/null 2>&1; then ok npm "$(npm -v)"; else bad npm "没有 npm"; fi
ok repo "$APP_DIR"

cd "$APP_DIR" || exit 1

# ---------- 依赖 ----------
if node -e "require('better-sqlite3')(':memory:').exec('create table t(a)')" >/dev/null 2>&1; then
  ok deps "better-sqlite3 可加载"
else
  bad deps "better-sqlite3 加载失败；先 npm rebuild better-sqlite3"
fi

if [ -f "$APP_DIR/dist/main.js" ]; then
  ok dist "dist/main.js 存在"
elif [ "$LAYER" = "demo" ]; then
  note dist "demo 不要求 dist"
else
  bad dist "dist/main.js 不存在；npm run build"
fi

# ---------- 配置 ----------
CFG=""
if [ -f "$APP_DIR/dist/config.js" ]; then
  CFG=$(node --input-type=module -e '
    const { loadConfig } = await import("./dist/config.js");
    const c = loadConfig();
    const w = c.webChat ?? {};
    console.log(`exec_mode=${c.exec.shell.mode}`);
    console.log(`feishu=${c.adapters.feishu.enabled ? 1 : 0}`);
    console.log(`matrix=${c.adapters.matrix.enabled ? 1 : 0}`);
    console.log(`webchat=${w.enabled !== false ? 1 : 0}`);
    console.log(`api_enabled=${c.api?.enabled === false ? 0 : 1}`);
    console.log(`api_port=${c.api?.port ?? 3738}`);
    console.log(`api_host=${c.api?.host ?? "0.0.0.0"}`);
    console.log(`llm_provider=${c.llm.provider}`);
    console.log(`runtime_dir=${c.runtimeDir}`);
    console.log(`data_dir=${c.dataDir}`);
  ' 2>/dev/null)
else
  CFG=$(npx --no-install tsx -e '
    import { loadConfig } from "./src/config.ts";
    const c = loadConfig();
    const w = c.webChat ?? {};
    console.log(`exec_mode=${c.exec.shell.mode}`);
    console.log(`feishu=${c.adapters.feishu.enabled ? 1 : 0}`);
    console.log(`matrix=${c.adapters.matrix.enabled ? 1 : 0}`);
    console.log(`webchat=${w.enabled !== false ? 1 : 0}`);
    console.log(`api_enabled=${c.api?.enabled === false ? 0 : 1}`);
    console.log(`api_port=${c.api?.port ?? 3738}`);
    console.log(`api_host=${c.api?.host ?? "0.0.0.0"}`);
    console.log(`llm_provider=${c.llm.provider}`);
    console.log(`runtime_dir=${c.runtimeDir}`);
    console.log(`data_dir=${c.dataDir}`);
  ' 2>/dev/null)
fi

cfg_get() { printf '%s\n' "$CFG" | sed -n "s/^$1=//p" | head -1; }

if [ -z "$CFG" ]; then
  bad config "读不到配置（dist/config.js 缺失且 tsx 不可用？）"
  EXEC_MODE=""; FEISHU=""; MATRIX=""; WEBCHAT=""; API_ENABLED=""; API_PORT="3738"; API_HOST="127.0.0.1"; PROVIDER=""; RUNTIME_DIR=""; DATA_DIR="$APP_DIR/data"
else
  EXEC_MODE="$(cfg_get exec_mode)"; FEISHU="$(cfg_get feishu)"; MATRIX="$(cfg_get matrix)"
  WEBCHAT="$(cfg_get webchat)"; API_ENABLED="$(cfg_get api_enabled)"; API_PORT="$(cfg_get api_port)"
  API_HOST="$(cfg_get api_host)"; PROVIDER="$(cfg_get llm_provider)"; RUNTIME_DIR="$(cfg_get runtime_dir)"
  DATA_DIR="$(cfg_get data_dir)"; [ -n "$DATA_DIR" ] || DATA_DIR="$APP_DIR/data"
  ok config "exec=${EXEC_MODE} feishu=${FEISHU} matrix=${MATRIX} webChat=${WEBCHAT} api=${API_ENABLED}:${API_PORT}"
fi

if [ "$FEISHU" = "1" ] || [ "$MATRIX" = "1" ] || [ "$WEBCHAT" = "1" ]; then
  ok exit_enabled "至少有一个出口"
else
  bad exit_enabled "飞书 / Matrix / 网页直聊都关着，run.sh 预检会 exit 2"
fi

if [ -n "$RUNTIME_DIR" ]; then
  if [ -d "$RUNTIME_DIR" ] && [ -w "$RUNTIME_DIR" ]; then
    ok runtime "可写：$RUNTIME_DIR"
  else
    warn runtime "不存在或不可写：$RUNTIME_DIR"
  fi
fi

# ---------- 任务执行器默认模型 ----------
# rabbit-bot 只在 task.model 非空时传 -m；空值会由本地编码 CLI 自己选。
# OpenCode 没配全局 model 会回退到最新可用模型，实测可能是免费模型，任务容易跑飞。
EXECUTOR="opencode"
if [ -f "$DATA_DIR/run/executor.json" ]; then
  EXECUTOR="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).executor||"opencode")}catch{console.log("opencode")}' "$DATA_DIR/run/executor.json" 2>/dev/null || echo opencode)"
fi
if [ "$EXECUTOR" = "opencode" ]; then
  if command -v opencode >/dev/null 2>&1; then
    CLI_MODEL="$( (cd "$HOME" && opencode debug config 2>/dev/null) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const m=a.map(x=>x&&x.info&&x.info.model).filter(Boolean)[0];console.log(m?m.providerID+"/"+m.model:"")}catch{console.log("")}})' 2>/dev/null)"
    if [ -z "$CLI_MODEL" ]; then
      warn coding_cli_model "opencode 没有配置默认模型，会回退到最新可用模型（可能是免费模型）；在 ~/.config/opencode/opencode.json 设 \"model\": \"deepseek/deepseek-flash\"，或建任务时显式指定 model"
    else
      case "$CLI_MODEL" in
        *free*) warn coding_cli_model "opencode 默认模型是免费模型 ${CLI_MODEL}，任务可能跑飞；建议换 deepseek/deepseek-flash" ;;
        *) ok coding_cli_model "opencode 默认模型 ${CLI_MODEL}" ;;
      esac
    fi
  else
    warn coding_cli_model "找不到 opencode；默认 worker=opencode 时任务无法执行"
  fi
fi

if [ "$LAYER" = "production" ]; then
  if [ "$EXEC_MODE" = "docker" ]; then
    ok exec_mode "production 使用 docker 沙盒"
  else
    bad exec_mode "production 要求 exec.shell.mode=docker，当前 ${EXEC_MODE:-未知}"
  fi
  if [ "$API_HOST" = "0.0.0.0" ]; then
    warn api_host "监听 0.0.0.0：确认已预置 Web 密码或有反向代理"
  fi
fi

# ---------- demo 只检查到依赖 ----------
if [ "$LAYER" = "demo" ]; then
  note layer "demo：只检查环境与依赖；下一步 npm run demo"
  printf 'SUMMARY\t%s\tPASS=%s WARN=%s FAIL=%s\n' "$LAYER" "$PASS" "$WARN" "$FAIL"
  [ "$FAIL" -eq 0 ] || exit 1
  exit 0
fi

# ---------- env / key ----------
if [ -f "$ENV_FILE" ]; then
  MODE="$(file_mode "$ENV_FILE")"
  if [ "$MODE" = "600" ]; then ok env_file "$ENV_FILE 权限 600"; else warn env_file "$ENV_FILE 权限 ${MODE:-未知}，建议 600"; fi
else
  if [ "$LAYER" = "feishu" ] || [ "$LAYER" = "production" ]; then
    bad env_file "$ENV_FILE 不存在"
  else
    warn env_file "$ENV_FILE 不存在（未给 Key 时无法启动正式服务）"
  fi
fi

if [ -n "$PROVIDER" ]; then
  if [ "$PROVIDER" = "google" ] || [ "$PROVIDER" = "gemini" ]; then
    if env_has GEMINI_API_KEY || env_has GOOGLE_API_KEY; then
      ok llm_key "provider=${PROVIDER}，GEMINI_API_KEY/GOOGLE_API_KEY set"
    else
      bad llm_key "provider=${PROVIDER}，GEMINI_API_KEY/GOOGLE_API_KEY missing"
    fi
  else
    case "$PROVIDER" in
      deepseek) KEYVAR="DEEPSEEK_API_KEY" ;;
      anthropic) KEYVAR="ANTHROPIC_API_KEY" ;;
      openai) KEYVAR="OPENAI_API_KEY" ;;
      openrouter) KEYVAR="OPENROUTER_API_KEY" ;;
      faux) KEYVAR="" ;;
      *) KEYVAR="DEEPSEEK_API_KEY" ;;
    esac
    if [ -z "$KEYVAR" ]; then
      warn llm_key "provider=faux，仅演示可用；正式服务不能启动"
    elif env_has "$KEYVAR"; then
      ok llm_key "provider=${PROVIDER}，${KEYVAR} set"
    else
      bad llm_key "provider=${PROVIDER}，${KEYVAR} missing"
    fi
  fi
fi

if [ "$FEISHU" = "1" ]; then
  if env_has FEISHU_APP_ID && env_has FEISHU_APP_SECRET; then ok feishu_env "FEISHU_APP_ID/SECRET set"; else bad feishu_env "feishu 开着但 FEISHU_APP_ID/SECRET missing"; fi
fi
if [ "$MATRIX" = "1" ]; then
  if env_has MATRIX_TOKEN; then ok matrix_env "MATRIX_TOKEN set"; else bad matrix_env "matrix 开着但 MATRIX_TOKEN missing"; fi
fi

# ---------- 进程 / 锁 ----------
NODE_N=$(pgrep -f "dist/main.js" 2>/dev/null | wc -l | tr -d ' ')
if [ "$NODE_N" = "1" ]; then
  ok process "dist/main.js 进程数 1"
elif [ "$NODE_N" = "0" ]; then
  if [ "$LAYER" = "auto" ]; then note process "未运行"; else bad process "未运行（pm2 start ecosystem.config.cjs）"; fi
else
  bad process "进程数 ${NODE_N}；会抢同一条消息"
fi

if [ -f "$DATA_DIR/run/main.pid" ]; then
  LOCK_PID=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid)}catch{process.exit(1)}' "$DATA_DIR/run/main.pid" 2>/dev/null || true)
  if [ -n "${LOCK_PID:-}" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    ok lock "main.pid=${LOCK_PID} 活着"
  else
    warn lock "main.pid=${LOCK_PID:-解析失败} 已死（残留）"
  fi
else
  if [ "$NODE_N" = "0" ]; then warn lock "没有锁文件"; else ok lock "锁文件未生成（刚启动？）"; fi
fi

# ---------- API ----------
API_UP=0
if [ "$API_ENABLED" != "1" ]; then
  if [ "$LAYER" = "auto" ]; then note api_health "api.disabled"; else bad api_health "api.enabled=false"; fi
else
  HEALTH="$(curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || true)"
  if printf '%s' "$HEALTH" | grep -q '"status":"ok"'; then
    API_UP=1
    MODE_IN_HEALTH="$(printf '%s' "$HEALTH" | sed -n 's/.*"exec":"\([^"]*\)".*/\1/p')"
    ok api_health "http://127.0.0.1:${API_PORT}/health ok（exec=${MODE_IN_HEALTH:-?}）"
  else
    if [ "$LAYER" = "auto" ]; then note api_health "未在听"; else bad api_health "http://127.0.0.1:${API_PORT}/health 不通"; fi
  fi
fi

# ---------- doctor ----------
if [ "$LAYER" != "auto" ] && [ "$NODE_N" = "1" ] && command -v npm >/dev/null 2>&1; then
  DOC="$(cd "$APP_DIR" && npm run doctor 2>&1 || true)"
  if printf '%s' "$DOC" | grep -q "读取失败"; then
    bad doctor "出现「mode: 读取失败」：doctor 可能还是旧版本"
  elif printf '%s' "$DOC" | grep -q "沙盒 shell"; then
    ok doctor "沙盒模式可读，进程/锁/API 见完整输出"
  else
    warn doctor "没看到沙盒段（输出异常？）"
  fi
fi

# ---------- Docker / 容器 ----------
if [ "$LAYER" = "production" ] || { [ "$EXEC_MODE" = "docker" ] && [ "$LAYER" != "auto" ]; }; then
  if ! command -v docker >/dev/null 2>&1; then
    bad docker "没有 docker"
  else
    OSTYPE="$(docker info --format '{{.OSType}}' 2>/dev/null || true)"
    if [ "$OSTYPE" = "linux" ]; then ok docker "OSType=linux"; else bad docker "OSType=${OSTYPE:-未知}：必须 Linux 容器"; fi
    STATUS="$(docker inspect -f '{{.State.Status}}' rabbit-bot-sbx 2>/dev/null || true)"
    if [ "$STATUS" = "running" ]; then
      ok sandbox "rabbit-bot-sbx running"
    elif [ -n "$STATUS" ]; then
      warn sandbox "rabbit-bot-sbx ${STATUS}（下次 terminal 会自建）"
    else
      warn sandbox "容器不存在（npm run sbx -- rebuild，或等首次 terminal 自建）"
    fi
  fi
fi

# ---------- pm2 ----------
if command -v pm2 >/dev/null 2>&1; then
  PM2_STATE="$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const p=a.find(x=>x?.name==="rabbit-bot");console.log(p?.pm2_env?.status||"missing")}catch{console.log("missing")}})' 2>/dev/null)"
  if [ "$PM2_STATE" = "online" ]; then
    ok pm2 "rabbit-bot online"
  elif [ "$LAYER" = "production" ]; then
    bad pm2 "rabbit-bot ${PM2_STATE:-missing}"
  else
    warn pm2 "rabbit-bot ${PM2_STATE:-missing}"
  fi
else
  if [ "$LAYER" = "production" ]; then bad pm2 "没有 pm2"; else warn pm2 "没有 pm2"; fi
fi

# ---------- 网页直聊往返 ----------
if [ "$ROUNDTRIP" = "1" ]; then
  if [ "$WEBCHAT" != "1" ]; then
    bad webchat_roundtrip "webChat 没开"
  elif [ "$API_UP" != "1" ]; then
    bad webchat_roundtrip "API 不在听，无法往返"
  else
    TOKEN="${RABBIT_BOT_API_TOKEN:-}"
    if [ -z "$TOKEN" ] && [ -f "$DATA_DIR/run/api.token" ]; then TOKEN="$(cat "$DATA_DIR/run/api.token")"; fi
    if [ -z "$TOKEN" ]; then
      bad webchat_roundtrip "没有 API token（RABBIT_BOT_API_TOKEN 或 data/run/api.token）"
    else
      SEND="$(curl -sS --max-time 5 -X POST "http://127.0.0.1:${API_PORT}/v1/webchat/send" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
        -d '{"text":"部署验收：在吗？收到请回一个字。"}' 2>/dev/null || true)"
      SEQ="$(printf '%s' "$SEND" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j?.data?.seq??"")}catch{console.log("")}})' 2>/dev/null)"
      if [ -z "$SEQ" ]; then
        bad webchat_roundtrip "发送失败：$(printf '%s' "$SEND" | head -c 160)"
      else
        note webchat_send "已入池 seq=${SEQ}，最多等 ${TIMEOUT}s"
        REPLY=""
        waited=0
        while [ "$waited" -lt "$TIMEOUT" ]; do
          sleep 2; waited=$((waited+2))
          REPLY="$(curl -sS --max-time 5 -H "Authorization: Bearer $TOKEN" \
            "http://127.0.0.1:${API_PORT}/v1/webchat/messages?after_seq=$((SEQ-1))&limit=50" 2>/dev/null |
            node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const m=(j.data?.messages||[]).filter(x=>x.from_self&&String(x.text||"").trim());if(m.length)console.log(String(m[m.length-1].text).replace(/\s+/g," ").slice(0,100))}catch{}})' 2>/dev/null || true)"
          [ -n "$REPLY" ] && break
        done
        if [ -n "$REPLY" ]; then
          ok webchat_roundtrip "收到自回复：${REPLY}"
        else
          bad webchat_roundtrip "${TIMEOUT}s 内没有自回复；按 references/troubleshooting.md D6 查"
        fi
      fi
    fi
  fi
fi

printf 'SUMMARY\t%s\tPASS=%s WARN=%s FAIL=%s\n' "$LAYER" "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
