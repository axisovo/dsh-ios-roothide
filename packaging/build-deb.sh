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
# 用 grep/sed 取版本，不依赖 node —— iOS 上 node 与 shell 的路径命名空间不一致
PKG_VERSION="$(grep -m1 '"version"' "$ROOT/package.json" | sed -e 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
VERSION="${1:-${PKG_VERSION:-0.0.0}}"
ARCH="iphoneos-arm64"
STAGE="$ROOT/.build/deb"
OUT="$ROOT/dist"

command -v dpkg-deb >/dev/null || { echo "需要 dpkg-deb（apt install dpkg）" >&2; exit 1; }

echo "▸ 版本 ${VERSION} / ${ARCH}"
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

# 4) 打 deb
DEB="$OUT/${PKG}_${VERSION}_${ARCH}.deb"
dpkg-deb -b "$STAGE" "$DEB" >/dev/null
echo "▸ 产物 ${DEB}  ($(du -h "$DEB" | cut -f1))"
dpkg-deb -I "$DEB" | sed 's/^/    /'
