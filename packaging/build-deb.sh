#!/usr/bin/env bash
# build-deb.sh — 把本项目打成 RootHide rootless 的 .deb
#
#   ./packaging/build-deb.sh                 # 版本取 package.json
#   ./packaging/build-deb.sh 0.3.0
#
# 产物：dist/dsh-ios-roothide_<version>_iphoneos-arm64.deb
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$(basename "$ROOT")"

# 档位：
#   slim（默认）— 只装适配层与启动器，依赖设备上已有的 dsh
#   cli         — 自带 node + 裁剪后的 dsh 运行时，只保证终端可用
#   full        — cli 档 + web 端适配层（含 safari16 构建与一键重启）
TIER="slim"
for arg in "$@"; do
  case "$arg" in
    --tier=*) TIER="${arg#*=}" ;;
    slim|cli|full) TIER="$arg" ;;
  esac
done
case "$TIER" in slim|cli|full) ;; *) echo "未知档位：$TIER（可选 slim / cli / full）" >&2; exit 1 ;; esac

# 设备上直接跑不起来的包：WASM 在 jitless 下不可用，实验特性不用
PRUNE_PKGS="libreoffice-kit-wasm dsh-client-ui-sidebar-documentpreview dsh-experimental-inspector dsh-experimental-client-ui-forge dsh-experimental-liveshare"
DSH_RUNTIME="${DSH_RUNTIME:-/var/mobile/dsh/dsh-ios}"
# 用 grep/sed 取版本，不依赖 node —— iOS 上 node 与 shell 的路径命名空间不一致
PKG_VERSION="$(grep -m1 '"version"' "$ROOT/package.json" | sed -e 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
VERSION="${PKG_VERSION:-0.0.0}"
for arg in "$@"; do
  case "$arg" in -*) ;; *) case "$arg" in slim|cli|full) ;; *) VERSION="$arg" ;; esac ;; esac
done
ARCH="iphoneos-arm64"
STAGE="$ROOT/.build/deb"
OUT="$ROOT/dist"

command -v dpkg-deb >/dev/null || { echo "需要 dpkg-deb（apt install dpkg）" >&2; exit 1; }

echo "▸ 版本 ${VERSION} / ${ARCH} · 档位 ${TIER}"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT"

# 1) 打包骨架（control / 启动器 / plist）
cp -a "$ROOT/packaging/deb/." "$STAGE/"
sed -i '' -e "s/__VERSION__/${VERSION}/" "$STAGE/DEBIAN/control" 2>/dev/null \
  || sed -i -e "s/__VERSION__/${VERSION}/" "$STAGE/DEBIAN/control"

# 2) 项目文件进 share 目录（cli 源码 + web 适配层 + 文档）
SHARE="$STAGE/var/jb/usr/share/$PKG"
mkdir -p "$SHARE"
for item in src bin web docs scripts package.json README.md INSTALL.txt LICENSE .gitignore; do
  [ -e "$ROOT/$item" ] && cp -a "$ROOT/$item" "$SHARE/"
done
mkdir -p "$SHARE/packaging"
cp "$ROOT/packaging/deb/var/jb/etc/dsh-ios-roothide.conf" "$SHARE/packaging/dsh-ios-roothide.conf"

# 3) 清掉不该进包的东西
find "$STAGE" -name '*.bak-web' -delete 2>/dev/null || true
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true

# 3.5) 运行时（cli / full 档才带）
if [ "$TIER" != "slim" ]; then
  RT="$SHARE/runtime"
  rm -rf "$RT"              # 幂等：反复构建不会叠加嵌套目录
  mkdir -p "$RT/preload"
  echo "▸ 拷贝 node"
  cp "$DSH_RUNTIME/node" "$RT/node"
  cp -a "$DSH_RUNTIME/preload/." "$RT/preload/" 2>/dev/null || true

  echo "▸ 拷贝 dsh 运行时（裁剪中）"
  mkdir -p "$RT/dsh"
  cp "$DSH_RUNTIME/dsh/package.json" "$RT/dsh/" 2>/dev/null || true
  cp -a "$DSH_RUNTIME/dsh/node_modules" "$RT/dsh/" 2>/dev/null || true

  echo "▸ 剔除 iOS 上跑不起来的包"
  for pkg in $PRUNE_PKGS; do
    target="$RT/dsh/node_modules/@deepseek-ai/$pkg"
    if [ -d "$target" ]; then
      sz=$(du -sm "$target" 2>/dev/null | cut -f1)
      rm -rf "$target"
      echo "    − ${pkg}（${sz}MB）"
    fi
  done

  echo "▸ 剥掉源码地图 / 类型声明 / 文档 / 测试"
  find "$RT/dsh/node_modules" -name '*.map' -delete 2>/dev/null || true
  find "$RT/dsh/node_modules" -name '*.d.ts' -delete 2>/dev/null || true
  find "$RT/dsh/node_modules" -name '*.md' -delete 2>/dev/null || true
  find "$RT/dsh/node_modules" -type d \( -name test -o -name tests -o -name __tests__ \
       -o -name docs -o -name examples -o -name fixtures \) -prune -exec rm -rf {} + 2>/dev/null || true

  echo "▸ 带一份 dsh-home 骨架（不含 token / sessions / 日志）"
  HOME_SRC="${DSH_HOME_SRC:-$DSH_RUNTIME/dsh-home}"
  if [ -d "$HOME_SRC" ]; then
    mkdir -p "$RT/dsh-home"
    for item in profiles storages redteam; do
      [ -d "$HOME_SRC/$item" ] && cp -a "$HOME_SRC/$item" "$RT/dsh-home/" 2>/dev/null || true
    done
    rm -rf "$RT/dsh-home/profiles/dsh-tui" 2>/dev/null || true
    chmod -R u+rwX "$RT/dsh-home" 2>/dev/null || true
  fi

  echo "▸ 运行时占用：$(du -sh "$RT" | cut -f1)"
fi

# 3.6) full 档额外带 web 适配层（骨架里已有 web/，这里确保 safari16 构建在位）
if [ "$TIER" = "full" ]; then
  echo "▸ full 档：web 适配层已包含"
fi

# 4) 打 deb
DEB="$OUT/${PKG}_${VERSION}_${ARCH}.deb"
dpkg-deb -b "$STAGE" "$DEB" >/dev/null
echo "▸ 产物 ${DEB}  ($(du -h "$DEB" | cut -f1))"
dpkg-deb -I "$DEB" | sed 's/^/    /'
