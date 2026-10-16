#!/usr/bin/env bash
# One command for a real testnet purchase against a local ComputePass:
#   computepass/scripts/testnet-demo.sh 0xTuDireccionReceptora [offerId]
# Starts the site locally (scripts/local-site.sh), then buys one pass with a
# throwaway testnet wallet (see agent/scripts/testnet-buy.ts). It never
# commits anything; the buyer key stays in ~/.computepass/.
set -euo pipefail
MERCHANT="${1:?uso: testnet-demo.sh 0xDireccionReceptora [offerId]}"
OFFER="${2:-llama-70b-burst}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENT="$ROOT/agent"; PORT=8788

"$ROOT/scripts/local-site.sh" "$MERCHANT"

cd "$AGENT"
[ -d node_modules ] || npm ci --no-audit --no-fund
COMPUTEPASS_API_URL="http://127.0.0.1:$PORT" npx tsx scripts/testnet-buy.ts "$OFFER"
