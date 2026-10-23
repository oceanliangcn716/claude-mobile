#!/bin/bash
# 只移除本安装的服务和快捷方式，保留全部程序与用户数据。
set -euo pipefail
APP="$(cd "$(dirname "$0")" && pwd)"
LABEL="local.$(id -un).claude-mobile"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$PLIST" ] && [ "$(plutil -extract WorkingDirectory raw -o - "$PLIST" 2>/dev/null || true)" = "$APP" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
fi
CONNECT="$HOME/Desktop/Claude手机连接.command"
if [ -f "$CONNECT" ] && grep -Fq "$APP/tools/connect.mjs" "$CONNECT"; then
  rm -f "$CONNECT"
fi
echo '本安装的自动启动已移除，程序及对话、附件数据均保留。'
