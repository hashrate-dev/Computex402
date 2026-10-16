# ComputePass 402: servidor MCP y agente de referencia

Dos piezas del hito 28 que no dependen del código del backend:

- **`src/mcp.ts`**: servidor MCP con las 6 herramientas del diseño (`list_compute_offers`, `quote_inference`, `buy_compute_pass`, `get_voucher_balance`, `redeem_inference`, `get_execution_receipt`). Modo stdio por defecto; `--http <puerto>` para MCP remoto (Streamable HTTP, exige `MCP_HTTP_TOKEN`).
- **`src/agent.ts`**: agente que descubre ofertas, las compara por precio y SLA, respeta un presupuesto, paga con x402, redime y emite un comprobante. Sin intervención humana y sin LLM: decide con reglas, que es lo que se puede demostrar de forma fiable.

Ambos hablan con la API documentada (`/api/status`, `/api/offers`, `/api/vouchers`, `/api/reservations`, `/api/redeem`) y pagan con el cliente oficial `@x402/fetch` + `@bnb-chain/b402` (esquema `exact`, método `eip3009`), el mismo que usa el sitio.

## Estado honesto

- Probado de extremo a extremo **solo contra `mock/server.ts`**, un servidor de prueba que implementa la API del documento. Verifica de verdad la firma EIP-3009, el pagador, el importe, el activo y el nonce, pero **la liquidación es simulada** (no toca la cadena) y la inferencia es un eco salvo que se configure `INFERENCE_API_URL`.
- **No se ha probado contra el ComputePass real**: el código no está disponible y la URL no es accesible desde aquí. Los nombres de campo que el documento no fija están marcados `ASSUMED` en `src/api.ts` (cuerpo de `/api/reservations` = `{offerId, owner}`, cuerpo de `/api/redeem` = `{voucherId, prompt, maxTokens, signature}`). Hay que alinearlos con el backend real.

## Uso

```bash
cp -r /mnt/project-files/computex402/computepass/agent ~/work/computepass-agent   # la carpeta compartida no admite symlinks
cd ~/work/computepass-agent && npm install
npm run e2e                                 # prueba completa contra el servidor de prueba (clave desechable, sin fondos)
```

Contra el backend real:

```bash
export COMPUTEPASS_API_URL=https://...      # API pública de ComputePass
export BUYER_PRIVATE_KEY=0x...              # wallet de prueba con U testnet; nunca llega al modelo
npx tsx src/agent.ts "Resume x402 en una frase" --units 256 --dry-run   # primero sin pagar
npx tsx src/agent.ts "Resume x402 en una frase" --units 256 [--model llama] [--max-latency 2000]
```

Cliente MCP (Claude Desktop, Claude Code, etc.):

```json
{ "mcpServers": { "computepass": {
  "command": "npx", "args": ["tsx", "/ruta/computepass-agent/src/mcp.ts"],
  "env": { "COMPUTEPASS_API_URL": "https://...", "BUYER_PRIVATE_KEY": "0x...", "BUDGET_MAX_PER_DAY": "0.1" } } } }
```

## Compatibilidad con OpenRouter

Tres puntos de contacto, todos con la interfaz OpenAI `chat/completions`:

1. **Cerebro del agente** (`src/llmAgent.ts`): un modelo de OpenRouter decide qué herramientas de ComputePass llamar (tool calling). La clave de la wallet nunca llega al modelo y el presupuesto se aplica en código, así que un modelo que se equivoque no puede gastar de más. Además hay una regla dura de una compra por tarea.
   ```bash
   export OPENROUTER_API_KEY=sk-or-...  LLM_MODEL=openai/gpt-4o-mini   # cualquier modelo con tool calling
   npx tsx src/llmAgent.ts "Resume x402 en una frase"
   ```
2. **Pasarela compatible OpenAI/OpenRouter** (`src/gateway.ts`): `GET /v1/models` y `POST /v1/chat/completions` (con `stream`). Cualquier SDK de OpenAI u OpenRouter apunta su `baseURL` a `http://localhost:8402/v1` y paga con vouchers: la pasarela elige un voucher con saldo, compra uno dentro del presupuesto si hace falta, firma la redención y devuelve la respuesta en formato OpenAI. Acepta como modelo `computepass/<oferta>`, `computepass/auto` (la más barata dentro del presupuesto) o el id de OpenRouter (`meta-llama/llama-3.3-70b-instruct`, `deepseek/deepseek-r1`). Sin presupuesto responde `402 insufficient_quota`.
   ```bash
   GATEWAY_TOKEN=elige-uno BUYER_PRIVATE_KEY=0x... npx tsx src/gateway.ts 8402
   ```
   Corre junto al comprador, no en el backend: `/api/redeem` exige una firma de wallet que un cliente OpenAI normal no sabe producir. Limitaciones: el historial de chat se aplana en un solo prompt (el backend solo acepta `prompt`), no hay tool calling a través de vouchers y `prompt_tokens` sale 0 porque el backend no lo informa.
3. **Proveedor de inferencia del backend**: `INFERENCE_API_URL=https://openrouter.ai/api/v1`, con un modelo de OpenRouter por oferta (ver `MODEL_MAP` en `mock/server.ts`, que es la referencia para portarlo al backend real).

`npm run e2e-openrouter` lo prueba todo contra un **OpenRouter simulado** (`mock/openrouter.ts`, un guion fijo, no un modelo) porque `openrouter.ai` está bloqueado en el entorno de desarrollo. Demuestra el formato y el bucle, no la calidad de las decisiones de un modelo real.

## Presupuesto (wallet delegada del MVP)

| Variable | Por defecto | Efecto |
|---|---|---|
| `BUDGET_MAX_PER_PURCHASE` | 0.05 U | Tope por compra. Se aplica dos veces: contra el precio anunciado y en el cliente x402 (`spendControls`), así un servidor que pida más de lo anunciado no recibe firma. |
| `BUDGET_MAX_PER_DAY` | 0.2 U | Tope diario, contado en `.computepass/ledger.json`. |
| `BUDGET_MAX_UNITS_PER_REDEEM` | 4096 | Máximo por redención. |
| `BUDGET_ALLOWED_OFFERS` / `BUDGET_ALLOWED_MODELS` | todas | Allowlist separada por comas. |
| `COMPUTEPASS_ASSET_DECIMALS` | 18 | Decimales del token U (**comprobar**). |

Limitación: el tope vive en este proceso, no onchain. Protege contra un modelo que se equivoca, no contra quien tenga la clave. Las session keys reales son fase 2.

## Pruebas (`npm run e2e`)

Compra la oferta más barata dentro del presupuesto, rechaza DeepSeek por el tope, reutiliza el voucher en la segunda ejecución, bloquea por tope diario, rechaza un 402 que cobra 10× lo anunciado antes de firmar, y ejercita las 6 herramientas MCP.
