#!/bin/zsh
set -e
cd "${0:A:h:h}"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print '从源码构建需要 Node.js 22+。也可以直接打开已下载的 ClawLink.app。'
  read -r '?按回车关闭…'
  exit 1
fi
if [[ ! -d node_modules ]]; then npm ci; fi
clawlink_version=$(node -p 'require("./package.json").version')
clawlink_app="$PWD/release/ClawLink-${clawlink_version}-arm64.app"
if [[ ! -d "$clawlink_app" ]]; then npm run release; fi
open "$clawlink_app"
