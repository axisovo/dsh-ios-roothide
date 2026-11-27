#!/bin/sh
# web.sh — LaunchDaemon 入口：起 dsh web 服务
set -eu

CONF=/var/jb/etc/dsh-ios-roothide.conf
[ -f "$CONF" ] && . "$CONF"

SHARE_DIR=/var/jb/usr/share/dsh-ios-roothide
# 自带运行时的包优先用自己的；否则退回设备上已有的 dsh 安装
if [ -z "${DSH_ROOT:-}" ] && [ -x "$SHARE_DIR/runtime/node" ]; then
  DSH_ROOT="$SHARE_DIR/runtime"
fi
DSH_ROOT="${DSH_ROOT:-/var/mobile/dsh/dsh-ios}"
DSH_HOME="${DSH_HOME:-$DSH_ROOT/dsh-home}"
DSH_PORT="${DSH_PORT:-3081}"
DSH_NODE_ARGS="${DSH_NODE_ARGS:---jitless}"

NODE="${DSH_NODE:-}"
[ -n "$NODE" ] || NODE="$DSH_ROOT/node"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "找不到 node；请在 $CONF 里配置 DSH_NODE" >&2; exit 1; }

BIN="$DSH_ROOT/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$BIN" ] || { echo "找不到 dsh 主程序：$BIN" >&2; exit 1; }

export HOME="${HOME:-/var/mobile}"
export DSH_HOME
mkdir -p "$DSH_HOME/logs"

# iOS 上缺这两个 shim 时 fetch/WebAssembly 会报 TRANSPORT 错误
SHIM_DIR="$DSH_ROOT/preload"
if [ -f "$SHIM_DIR/fetch-https-shim.js" ]; then
  export NODE_OPTIONS="$DSH_NODE_ARGS --import=$SHIM_DIR/wasm-polyfill.js --import=$SHIM_DIR/fetch-https-shim.js"
else
  export NODE_OPTIONS="$DSH_NODE_ARGS"
fi

echo "[dsh-ios-roothide] $(date '+%F %T') start web on :$DSH_PORT  node=$NODE"
exec "$NODE" "$BIN" web --port "$DSH_PORT" --no-open
