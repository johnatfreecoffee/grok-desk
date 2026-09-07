#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
STATE="${HOME}/.grok/phone-mcp"
mkdir -p "${STATE}/jobs"
if [[ ! -f "${STATE}/token" ]]; then
  openssl rand -hex 24 > "${STATE}/token"
  chmod 600 "${STATE}/token"
fi
export GROK_MCP_TOKEN="$(tr -d '[:space:]' < "${STATE}/token")"
export GROK_MCP_PORT="${GROK_MCP_PORT:-3311}"
export GROK_MCP_ROOTS="${GROK_MCP_ROOTS:-${HOME}/Documents}"
export GROK_MCP_ALLOW_AUTO="${GROK_MCP_ALLOW_AUTO:-1}"
export PATH="${HOME}/.grok/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"
cd "$ROOT"
NODE="$(command -v node)"
exec /usr/bin/caffeinate -s "$NODE" server.mjs
