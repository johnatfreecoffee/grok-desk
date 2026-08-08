#!/usr/bin/env bash
# Start Grok Desk daemon (serves UI + agent bridge on 127.0.0.1:8787)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  npm install
fi
if [[ ! -d web/node_modules ]]; then
  npm install --prefix web
fi
if [[ ! -f web/dist/index.html ]]; then
  npm run build --prefix web
fi

exec node daemon/index.js
