#!/bin/zsh
set -e
cd "${0:A:h:h}"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print '请先安装 Node.js 22 或更新版本，然后重新打开。'
  read -r '?按回车关闭…'
  exit 1
fi
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ ! -x native/ClawLinkBridge || native/ClawLinkBridge.swift -nt native/ClawLinkBridge ]]; then
  npm run native:build
fi
if curl --silent --fail http://127.0.0.1:4173/api/health >/dev/null; then
  open http://localhost:4173
  exit 0
fi
node server/index.js &
clawlink_server_pid=$!
trap 'kill "$clawlink_server_pid" 2>/dev/null || true' EXIT INT TERM
for clawlink_attempt in {1..40}; do
  if curl --silent --fail http://127.0.0.1:4173/api/health >/dev/null; then
    open http://localhost:4173
    break
  fi
  if ! kill -0 "$clawlink_server_pid" 2>/dev/null; then
    wait "$clawlink_server_pid"
    exit 1
  fi
  sleep 0.25
done
wait "$clawlink_server_pid"
