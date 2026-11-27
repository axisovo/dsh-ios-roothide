#!/usr/bin/env bash
# install.sh — 一条命令装好两端
#
# 顺序是固定的：先让 web 服务起来（开放端口），再接 cli。
#   ./install.sh                          # 自动找 web 前端目录，装适配层 → 重启 → 校验端口
#   ./install.sh /path/to/dist            # 指定 dist
#   ./install.sh --no-restart             # 只装文件，不重启服务
#   ./install.sh --web-only / --cli-only  # 只做一半
#
# 之所以必须先 web 后 cli：cli 是纯前端，连不上 3081 什么事都做不了。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${DSH_PORT:-3081}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
DO_WEB=1
DO_CLI=1
DO_RESTART=1
DIST=""

for arg in "$@"; do
  case "$arg" in
    --web-only) DO_CLI=0 ;;
    --cli-only) DO_WEB=0 ;;
    --no-restart) DO_RESTART=0 ;;
    -*) echo "未知参数：$arg" >&2; exit 1 ;;
    *) DIST="$arg" ;;
  esac
done

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m×\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "没有 node（需要 >= 18）"
NODE_VER="$(node -p 'process.versions.node')"
say "node ${NODE_VER}"

# ── 1. 找到 web 前端目录 ────────────────────────────────────────
find_dist() {
  [ -n "$DIST" ] && { echo "$DIST"; return; }
  local c
  for c in \
    "${DSH_DIST:-}" \
    "$DSH_HOME_DIR/node_modules/@deepseek-ai/dsh-web-frontend/dist" \
    "$(dirname "$DSH_HOME_DIR")/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist" \
    "$ROOT/../dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist" \
    "$ROOT/../dsh-ios/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist"; do
    [ -n "$c" ] && [ -f "$c/index.html" ] && { echo "$c"; return; }
  done
  echo ""
}

# ── 2. web 端：装适配层 → 重启 → 开放端口 ───────────────────────
if [ "$DO_WEB" -eq 1 ]; then
  DIST_FOUND="$(find_dist)"
  if [ -z "$DIST_FOUND" ]; then
    warn "没找到 dsh-web-frontend/dist，跳过 web 适配层"
    warn "  指定一下：./install.sh /path/to/@deepseek-ai/dsh-web-frontend/dist"
  else
    say "web 适配层 → ${DIST_FOUND}"
    "$ROOT/web/install-web.sh" "$DIST_FOUND" >/dev/null
    say "web 适配层已安装（原文件备份为 *.bak-web）"

    if [ "$DO_RESTART" -eq 1 ]; then
      say "请求服务重启（POST /dsh-purge/restart）"
      node -e '
        const http = require("node:http");
        const body = JSON.stringify({ reason: "install.sh" });
        const req = http.request({ host: "127.0.0.1", port: Number(process.argv[1]), path: "/dsh-purge/restart", method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 8000 }, (res) => {
          res.resume();
          console.log(`  端点返回 ${res.statusCode}`);
        });
        req.on("timeout", () => { req.destroy(); console.log("  端点超时（可手动重启）"); });
        req.on("error", (e) => { console.log(`  端点不可用（${e.code || e.message}）`); });
        req.end(body);
      ' "$PORT" || true
      sleep 3
    fi
  fi
fi

# ── 3. 校验端口是否开放 ────────────────────────────────────────
say "校验端口 ${PORT}"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if node -e '
      const net = require("node:net");
      const s = net.connect(Number(process.argv[1]), "127.0.0.1");
      s.on("connect", () => { s.destroy(); process.exit(0); });
      s.on("error", () => process.exit(1));
      setTimeout(() => { s.destroy(); process.exit(1); }, 800);
    ' "$PORT"; then
    say "端口已开放 ✔"
    PORT_OK=1
    break
  fi
  PORT_OK=0
  sleep 1
done

if [ "${PORT_OK:-0}" -ne 1 ]; then
  warn "端口 ${PORT} 还没起来 —— cli 端会连不上"
  warn "  先启动服务端：dsh web --port ${PORT}（或 dsh-daemon.sh）"
fi

# ── 4. cli 端 ─────────────────────────────────────────────────
if [ "$DO_CLI" -eq 1 ]; then
  if [ ! -d "$ROOT/node_modules/ws" ] && [ ! -d "$ROOT/src" ]; then
    die "源码不完整"
  fi
  if [ ! -d "$ROOT/node_modules/ws" ]; then
    if command -v npm >/dev/null; then
      say "安装依赖（ws）"
      (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) || warn "npm install 失败，可手动装 ws 或用 DSH_WS_MODULE"
    else
      warn "没有 npm：请手动提供 ws，或设置 DSH_WS_MODULE 指向纯 JS 副本"
    fi
  fi
  if [ -f "$DSH_HOME_DIR/.launch-token" ]; then
    say "找到 ${DSH_HOME_DIR}/.launch-token ✔"
  else
    warn "没有找到 ${DSH_HOME_DIR}/.launch-token —— 用 DSH_HOME 指向 dsh 数据目录"
  fi
fi

cat <<EOF

────────────────────────────────────────────────
安装完成。

  cli 端：
    export DSH_HOME=${DSH_HOME_DIR}
    export DSH_PORT=${PORT}
    node "${ROOT}/bin/ds.mjs"        # 或 npm link 后直接 ds

  web 端：
    浏览器打开 http://127.0.0.1:${PORT}
    iOS 上先强刷一次；左下角出现「⟳ 重启」

  详细步骤与排障见 INSTALL.txt
────────────────────────────────────────────────
EOF
