#!/usr/bin/env bash
# install-web.sh — 把 iOS 适配层装进 dsh 的 web 前端目录
#
#   ./web/install-web.sh /path/to/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist
#   DSH_DIST=/path/to/dist ./web/install-web.sh
#
# 做的事：
#   1. 备份会被覆盖的原文件（*.bak-web）
#   2. 拷贝 polyfill / iOS 兼容脚本 / safari16 构建 / 适配后的 index.html
#   3. 落地一键重启按钮 restart-button.js
# 装完重启 dsh web，手机 Safari 强刷即可。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="${1:-${DSH_DIST:-}}"
if [ -z "$DIST" ]; then
  echo "用法：$0 <dsh-web-frontend/dist 路径>" >&2
  echo "  例：$0 ~/.dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist" >&2
  exit 1
fi
[ -d "$DIST" ] || { echo "× 目录不存在：$DIST" >&2; exit 1; }

backup() {
  local target="$1"
  if [ -e "$target" ] && [ ! -e "$target.bak-web" ]; then
    cp "$target" "$target.bak-web"
    echo "  备份 $(basename "$target") → $(basename "$target").bak-web"
  fi
}

echo "▸ 安装到 $DIST"
mkdir -p "$DIST/assets"

for f in iterator-polyfill.js es-late-polyfill.js keyboard-inset.js keyboard-inset.css \
         composer-focus-ios.js settings-mobile.css; do
  backup "$DIST/$f"
  cp "$HERE/shim/$f" "$DIST/$f"
  echo "  + $f"
done

backup "$DIST/restart-button.js"
cp "$HERE/restart-button.js" "$DIST/restart-button.js"
echo "  + restart-button.js"

for f in index-safari16-v2.js vendor-safari16.js; do
  backup "$DIST/assets/$f"
  cp "$HERE/assets/$f" "$DIST/assets/$f"
  echo "  + assets/$f"
done

backup "$DIST/index.html"
cp "$HERE/index.html" "$DIST/index.html"
echo "  + index.html（已注入适配脚本与重启按钮）"

echo "▸ 完成。重启 dsh web 后在 Safari 里强刷："
echo "    curl -X POST http://127.0.0.1:3081/dsh-purge/restart -H 'content-type: application/json' -d '{\"reason\":\"install-web\"}'"
