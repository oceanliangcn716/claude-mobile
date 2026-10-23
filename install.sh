#!/bin/bash
# macOS 安装/更新；INSTALL_NO_START=1 只准备文件，不注册或启动登录服务。
set -euo pipefail
APP="$(cd "$(dirname "$0")" && pwd)"
NODE_VERSION="${NODE_VERSION:-v24.22.1}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
LABEL="local.$(id -un).claude-mobile"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONNECT="$HOME/Desktop/Claude手机连接.command"
[ "$(uname)" = Darwin ] || { echo '只支持 macOS'; exit 1; }
[[ "$NODE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'NODE_VERSION 格式错误'; exit 1; }
TASK_TMP=''
trap '[ -z "$TASK_TMP" ] || rm -rf "$TASK_TMP"' EXIT
if [ ! -x "$APP/runtime/node/bin/node" ]; then
  case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo '不支持的 CPU'; exit 1 ;; esac
  f="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
  TASK_TMP="$(mktemp -d)"
  echo "下载并校验 Node.js $NODE_VERSION"
  curl -fL --retry 3 -o "$TASK_TMP/$f" "https://nodejs.org/dist/$NODE_VERSION/$f"
  curl -fsSL --retry 3 -o "$TASK_TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$TASK_TMP" && grep " $f\$" SHASUMS256.txt | shasum -a 256 -c -)
  mkdir -p "$APP/runtime"
  tar -xzf "$TASK_TMP/$f" -C "$APP/runtime"
  ln -sfn "node-$NODE_VERSION-darwin-$ARCH" "$APP/runtime/node"
fi
export PATH="$APP/runtime/node/bin:$PATH"
cd "$APP"
echo '安装依赖'
npm ci --omit=dev --no-fund --no-audit --registry="$REGISTRY"
mkdir -p web/vendor web/icons logs
cp node_modules/marked/lib/marked.umd.js web/vendor/marked.js
cp node_modules/dompurify/dist/purify.min.js web/vendor/purify.js 2>/dev/null || cp node_modules/dompurify/dist/purify.js web/vendor/purify.js
if [ ! -f web/icons/apple-touch-icon.png ]; then
  src=/Applications/Claude.app/Contents/Resources/electron.icns
  if [ -f "$src" ]; then
    [ -n "$TASK_TMP" ] || TASK_TMP="$(mktemp -d)"
    sips -s format png "$src" --out "$TASK_TMP/src.png" >/dev/null
    if command -v swift >/dev/null 2>&1 && (cd "$TASK_TMP" && swift "$APP/tools/make-icons.swift" src.png 0.015 180 192 512) >/dev/null 2>&1; then
      cp "$TASK_TMP"/icon-*.png web/icons/
    else
      for s in 180 192 512; do sips -z $s $s "$TASK_TMP/src.png" --out "web/icons/icon-$s.png" >/dev/null; done
    fi
    cp web/icons/icon-180.png web/icons/apple-touch-icon.png
  else
    echo '未找到 Claude.app，跳过可选图标'
  fi
fi
mkdir -p "$HOME/Desktop"
printf '#!/bin/bash\nexec %q %q\n' "$APP/runtime/node/bin/node" "$APP/tools/connect.mjs" > "$CONNECT"
chmod 755 "$CONNECT"
if [ "${INSTALL_NO_START:-0}" = 1 ]; then
  echo '文件已准备好；运行 npm start 可手动启动。'
  exit 0
fi
# 只管理这个安装目录自己的服务；不删除其他安装的 plist。
if [ -f "$PLIST" ]; then
  old_app=$(/usr/bin/plutil -extract WorkingDirectory raw -o - "$PLIST" 2>/dev/null || true)
  [ "$old_app" = "$APP" ] || { echo '已有其他目录的服务，请先从旧目录卸载或手动运行 npm start。'; exit 1; }
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
fi
mkdir -p "$HOME/Library/LaunchAgents"
export APP LABEL PLIST
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const { APP, LABEL, PLIST, HOME } = process.env;
fs.writeFileSync(PLIST, JSON.stringify({
  Label: LABEL,
  ProgramArguments: [path.join(APP, 'runtime/node/bin/node'), path.join(APP, 'server.mjs')],
  WorkingDirectory: APP,
  EnvironmentVariables: { PATH: `${APP}/runtime/node/bin:${HOME}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'zh_CN.UTF-8' },
  RunAtLoad: true, KeepAlive: true,
  StandardOutPath: path.join(APP, 'logs/launchd.log'), StandardErrorPath: path.join(APP, 'logs/launchd.log'),
}), { mode: 0o600 });
JS
plutil -convert xml1 "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
port=$(node --input-type=module -e 'import fs from "node:fs"; let p=3082; try { p=JSON.parse(fs.readFileSync("config.json")).port || p; } catch {} process.stdout.write(String(p));')
for attempt in {1..15}; do
  if curl -fsS "http://127.0.0.1:$port/api/ping" >/dev/null 2>&1; then
    echo '安装完成。双击桌面的「Claude手机连接」，在 iPhone Safari 粘贴配对链接，再添加到主屏幕。'
    exit 0
  fi
  sleep 1
done
echo "服务未就绪，请检查 $APP/logs/launchd.log 和 logs/server.log"
exit 1
