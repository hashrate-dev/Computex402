#!/usr/bin/env bash
# One command for a real testnet purchase against a local ComputePass:
#   computepass/scripts/testnet-demo.sh 0xTuDireccionReceptora [offerId]
# Builds the site, applies pending D1 migrations locally, starts the Worker on
# 127.0.0.1:8788 with that MERCHANT_ADDRESS, then buys one pass with a
# throwaway testnet wallet (see agent/scripts/testnet-buy.ts). It never
# commits anything; the buyer key stays in ~/.computepass/.
set -euo pipefail
MERCHANT="${1:?uso: testnet-demo.sh 0xDireccionReceptora [offerId]}"
OFFER="${2:-llama-70b-burst}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"; AGENT="$ROOT/agent"; PORT=8788

[[ "$MERCHANT" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "dirección inválida: $MERCHANT"; exit 1; }

cd "$WEB"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build >/dev/null
WRANGLER=(node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js)
APPLIED=".wrangler/state/computepass-migrations.txt"
mkdir -p .wrangler/state && touch "$APPLIED"
for f in drizzle/*.sql; do
  grep -qxF "$f" "$APPLIED" && continue
  if out=$("${WRANGLER[@]}" d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file "$f" 2>&1); then
    echo "migración aplicada: $f"
  elif grep -qiE "already exists|duplicate column" <<<"$out"; then
    echo "migración ya estaba aplicada: $f"
  else
    echo "$out" | tail -20; exit 1
  fi
  echo "$f" >> "$APPLIED"
done
printf 'MERCHANT_ADDRESS=%s\n' "$MERCHANT" > dist/server/.dev.vars
[ -n "${INFERENCE_API_KEY:-}" ] && printf 'INFERENCE_API_KEY=%s\n' "$INFERENCE_API_KEY" >> dist/server/.dev.vars

if ! curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null; then
  nohup npm start -- --port "$PORT" > "$WEB/.wrangler/computepass-server.log" 2>&1 &
  for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null && break; sleep 1; done
fi
curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null || { echo "el sitio no arrancó; ver computepass/web/.wrangler/computepass-server.log"; exit 1; }
echo "Sitio en http://127.0.0.1:$PORT"

cd "$AGENT"
[ -d node_modules ] || npm ci --no-audit --no-fund
COMPUTEPASS_API_URL="http://127.0.0.1:$PORT" npx tsx scripts/testnet-buy.ts "$OFFER"
