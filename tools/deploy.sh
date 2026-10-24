#!/bin/bash
# 把这个 Git 仓库的代码部署到本机运行目录，并重启服务。
# 保留运行目录里的配置、配对密钥、附件、日志、Node 运行时和手机工作区；旧代码先备份。
# 用法：tools/deploy.sh [运行目录，默认 ~/.local/share/claude-mobile]
# 有手机任务正在运行时拒绝部署（重启会中断任务）；确认要中断时加 FORCE=1。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HOME/.local/share/claude-mobile}"
[ "$REPO" != "$TARGET" ] || { echo '运行目录就是仓库本身，直接运行 ./install.sh 即可'; exit 1; }
mkdir -p "$TARGET"

# 1. 正在运行的手机任务
port=$(sed -nE 's/.*"port": *([0-9]+).*/\1/p' "$TARGET/config.json" 2>/dev/null | head -1)
port=${port:-3082}
if [ "${FORCE:-0}" != 1 ] && state=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/state" 2>/dev/null); then
  if printf '%s' "$state" | grep -q '"busy":true'; then
    echo "手机引擎里有任务正在运行，部署会中断它。等它结束，或用 FORCE=1 强制部署。"
    exit 1
  fi
fi

# 2. 版本标识：版本号 + 提交号（有未提交改动时标记 modified）
version=$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' "$REPO/package.json" | head -1)
commit=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo nogit)
[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ] || commit="$commit-modified"
build="$version+$commit"

# 3. 备份旧代码（不含数据），再同步新代码
KEEP=(--exclude=.git/ --exclude=node_modules --exclude=runtime --exclude=private/ --exclude=logs/ --exclude=backups/
      --exclude=mobile-workspace/ --exclude=config.json --exclude=web/vendor/ --exclude='web/icons/*.png' --exclude=BUILD --exclude=.DS_Store)
if [ -f "$TARGET/server.mjs" ]; then
  backup="$TARGET/backups/code-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  rsync -a "${KEEP[@]}" "$TARGET/" "$backup/"
  echo "旧代码已备份到 $backup"
fi
rsync -a --delete "${KEEP[@]}" "$REPO/" "$TARGET/"
printf '%s\n' "$build" > "$TARGET/BUILD"

# 4. 停掉指向同一目录的旧服务（旧版本用过别的服务名），避免端口冲突
for p in "$HOME"/Library/LaunchAgents/*claude-mobile.plist; do
  [ -e "$p" ] || continue
  wd=$(/usr/bin/plutil -extract WorkingDirectory raw -o - "$p" 2>/dev/null || true)
  [ "$wd" = "$TARGET" ] || continue
  launchctl bootout "gui/$(id -u)" "$p" 2>/dev/null || true
  [ "$(basename "$p")" = "local.$(id -un).claude-mobile.plist" ] || rm -f "$p"
done

# 5. 安装依赖、写服务、重启
"$TARGET/install.sh"

sleep 2
running=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/ping" | sed -nE 's/.*"build":"([^"]+)".*/\1/p')
echo "部署版本：${build}；服务报告的运行版本：${running:-未知}"
[ "$running" = "$build" ] || { echo '运行版本和部署版本不一致，查看日志'; exit 1; }
