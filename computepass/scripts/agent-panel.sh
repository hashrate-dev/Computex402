#!/usr/bin/env bash
# The buyer agent running on its own, managed from the /admin panel:
#   computepass/scripts/agent-panel.sh 0xDireccionReceptora
# Starts the site locally (local-site.sh), then runs the agent in the
# foreground with the testnet wallet in ~/.computepass/testnet-buyer.key.
# The agent starts PAUSED: turn it on from the panel. Ctrl-C stops it.
# To point it at a published site instead: COMPUTEPASS_API_URL=https://... and
# the same AGENT_TOKEN configured there.
set -euo pipefail
MERCHANT="${1:?uso: agent-panel.sh 0xDireccionReceptora}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTROL="${COMPUTEPASS_CONTROL_FILE:-$HOME/.computepass/control.env}"

if [ -z "${COMPUTEPASS_API_URL:-}" ]; then
  "$ROOT/scripts/local-site.sh" "$MERCHANT"
  export COMPUTEPASS_API_URL="http://127.0.0.1:8788"
fi
# shellcheck disable=SC1090
source "$CONTROL"
export AGENT_TOKEN
echo "Clave del panel (ADMIN_TOKEN) en $CONTROL"

cd "$ROOT/agent"
[ -d node_modules ] || npm ci --no-audit --no-fund
export COMPUTEPASS_STATE_DIR="${COMPUTEPASS_STATE_DIR:-$HOME/.computepass/state}"
exec npx tsx src/daemon.ts
