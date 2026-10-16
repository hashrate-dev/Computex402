#!/usr/bin/env bash
# Runs the ComputePass site locally on 127.0.0.1:8788 (Worker + local D1):
#   computepass/scripts/local-site.sh 0xDireccionReceptora
# Builds, applies pending D1 migrations, writes dist/server/.dev.vars and
# starts the Worker in the background. The panel and agent tokens live in
# ~/.computepass/control.env (created on first run, mode 600, never in the repo).
set -euo pipefail
MERCHANT="${1:?uso: local-site.sh 0xDireccionReceptora}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"; PORT=8788
CONTROL="${COMPUTEPASS_CONTROL_FILE:-$HOME/.computepass/control.env}"

[[ "$MERCHANT" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "dirección inválida: $MERCHANT"; exit 1; }

if [ ! -f "$CONTROL" ]; then
  mkdir -p "$(dirname "$CONTROL")" && chmod 700 "$(dirname "$CONTROL")"
  umask 077
  printf 'ADMIN_TOKEN=%s\nAGENT_TOKEN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$CONTROL"
  echo "Claves del panel y del agente creadas en $CONTROL"
fi
chmod 600 "$CONTROL"
# shellcheck disable=SC1090
source "$CONTROL"

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
{
  printf 'MERCHANT_ADDRESS=%s\nADMIN_TOKEN=%s\nAGENT_TOKEN=%s\n' "$MERCHANT" "$ADMIN_TOKEN" "$AGENT_TOKEN"
  [ -n "${INFERENCE_API_KEY:-}" ] && printf 'INFERENCE_API_KEY=%s\n' "$INFERENCE_API_KEY"
  [ -n "${BSC_RPC_URL:-}" ] && printf 'BSC_RPC_URL=%s\n' "$BSC_RPC_URL"
} > dist/server/.dev.vars
chmod 600 dist/server/.dev.vars

# A site started earlier without these settings has to be restarted to pick them up.
if curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $ADMIN_TOKEN" "http://127.0.0.1:$PORT/api/admin/agent")
  if [ "$code" != "200" ]; then
    echo "reiniciando el sitio local para cargar la configuración nueva"
    lsof -ti "tcp:$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
    sleep 2
  fi
fi
if ! curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null; then
  nohup npm start -- --port "$PORT" > "$WEB/.wrangler/computepass-server.log" 2>&1 &
  for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null && break; sleep 1; done
fi
curl -sf "http://127.0.0.1:$PORT/api/status" >/dev/null || { echo "el sitio no arrancó; ver computepass/web/.wrangler/computepass-server.log"; exit 1; }
echo "Sitio en http://127.0.0.1:$PORT · panel en http://127.0.0.1:$PORT/admin"
