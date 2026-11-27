#!/usr/bin/env bash
# 包装：统一走 Node 版（不依赖 git/curl）
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/upload.mjs" "$@"
