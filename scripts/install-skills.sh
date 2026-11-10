#!/usr/bin/env bash
# 把仓库里的项目级技能组同步到 ~/.agents/skill-library/rabbit-bot，
# 在 ~/.agents/skills/rabbit-bot 只放一个索引 SKILL.md。
#
#   bash scripts/install-skills.sh           # 默认 symlink 技能组，索引每次重写
#   bash scripts/install-skills.sh --copy    # 复制技能组，适合部署后不再改仓库
#   AGENTS_SKILLS_DIR=/path AGENTS_SKILL_LIBRARY=/path bash scripts/install-skills.sh
#   RABBIT_BOT_SKIP_SKILLS=1 npm install     # 安装时跳过
#
# 为什么分开：扫描器会递归找 SKILL.md。子技能如果放在 ~/.agents/skills/rabbit-bot 下，
# 会和索引一起被当成多个技能；放到 skill-library 后，skills 下只留索引。
#
# 默认 best-effort：同步失败只警告，不让 npm install 失败。
# 要严格失败：RABBIT_BOT_SKILLS_STRICT=1。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/skills/rabbit-bot"
INDEX_SRC="$SRC/_shared/installed-index.md"
SKILLS_ROOT="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
LIBRARY_ROOT="${AGENTS_SKILL_LIBRARY:-$HOME/.agents/skill-library}"
LIB_TARGET="$LIBRARY_ROOT/rabbit-bot"
INDEX_TARGET="$SKILLS_ROOT/rabbit-bot"
MODE="link"

usage() {
  echo "用法：$0 [--link|--copy]" >&2
  echo "  --link  软链技能组到仓库（默认，改仓库立即生效）" >&2
  echo "  --copy  复制技能组到 skill-library" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --link) MODE="link" ;;
    --copy) MODE="copy" ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
  shift
done

warn() {
  echo "⚠ $*" >&2
  if [ "${RABBIT_BOT_SKILLS_STRICT:-0}" = "1" ]; then exit 1; fi
  exit 0
}

if [ "${RABBIT_BOT_SKIP_SKILLS:-0}" = "1" ]; then
  echo "跳过技能同步（RABBIT_BOT_SKIP_SKILLS=1）"
  exit 0
fi

[ -f "$SRC/SKILL.md" ] || warn "找不到技能组：$SRC/SKILL.md"
[ -f "$INDEX_SRC" ] || warn "找不到索引模板：$INDEX_SRC"
[ -n "${HOME:-}" ] || warn "HOME 为空，无法定位 ~/.agents"

mkdir -p "$SKILLS_ROOT" "$LIBRARY_ROOT"

# 1) 技能组本体：~/.agents/skill-library/rabbit-bot
if [ "$MODE" = "copy" ]; then
  if [ -e "$LIB_TARGET" ] && [ ! -L "$LIB_TARGET" ]; then
    backup="$LIB_TARGET.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$LIB_TARGET" "$backup"
    echo "已备份旧技能组：$backup"
  fi
  rm -f "$LIB_TARGET"
  mkdir -p "$LIB_TARGET"
  cp -R "$SRC"/. "$LIB_TARGET"/
  echo "已复制技能组：$SRC → $LIB_TARGET"
else
  if [ -e "$LIB_TARGET" ] && [ ! -L "$LIB_TARGET" ]; then
    warn "技能组目录已存在且不是软链：$LIB_TARGET（先移走，或用 --copy）"
  fi
  ln -sfn "$SRC" "$LIB_TARGET"
  echo "已链接技能组：$LIB_TARGET → $SRC"
fi

# 2) 索引：~/.agents/skills/rabbit-bot 里只放一个 SKILL.md
#    旧版本如果在这里放了子目录，整个移走/备份，避免扫描器递归发现多份 SKILL.md
if [ -L "$INDEX_TARGET" ]; then
  rm -f "$INDEX_TARGET"
elif [ -e "$INDEX_TARGET" ] && [ ! -d "$INDEX_TARGET" ]; then
  backup="$INDEX_TARGET.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$INDEX_TARGET" "$backup"
  echo "已备份旧索引文件：$backup"
elif [ -d "$INDEX_TARGET" ]; then
  # 只有 SKILL.md 就原地覆盖；有子目录/其他文件才备份，避免旧子技能被递归扫描
  extra="$(find "$INDEX_TARGET" -mindepth 1 -maxdepth 1 ! -name SKILL.md -print -quit)"
  if [ -n "$extra" ]; then
    backup="$INDEX_TARGET.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$INDEX_TARGET" "$backup"
    echo "已备份旧索引目录：$backup"
  fi
fi
mkdir -p "$INDEX_TARGET"

escaped_lib="$(printf '%s' "$LIB_TARGET" | sed 's/[&|]/\\&/g')"
sed "s|{{SKILL_LIBRARY}}|$escaped_lib|g" "$INDEX_SRC" > "$INDEX_TARGET/SKILL.md"
echo "已写入索引：$INDEX_TARGET/SKILL.md → $LIB_TARGET"
