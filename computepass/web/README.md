# ComputePass 402: sitio y API

Venta de capacidad de inferencia pagada con x402 en BSC Testnet. El comprador paga una vez (EIP-3009 en token U), recibe un voucher con N unidades y lo consume firmando cada redención con su wallet. Una unidad es un token del proveedor, de entrada o de salida.

Next.js (vinext) sobre Cloudflare Workers + D1. Nació como un starter de ChatGPT Sites; `.openai/hosting.json`, `build/` y `scripts/` son de ese hosting y se conservan para que el sitio siga desplegándose igual.

## Estructura

| Ruta | Qué es |
| --- | --- |
| `app/page.tsx` | Mercado, compra x402 desde el navegador, inventario y redención. |
| `app/docs/page.tsx` | Manual y referencia de la API. |
| `app/api/*/route.ts` | Rutas finas: solo conectan el Worker con los handlers. |
| `lib/server/` | Lógica de negocio (compra, redención, inventario) sin dependencias del Worker, para poder probarla. |
| `lib/protocol.ts` | Mensaje de redención v2. Lo importan el servidor, el navegador y `../agent`. |
| `lib/catalog.ts` | Ofertas, precio atómico y modelo del proveedor de cada oferta. |
| `db/schema.ts`, `drizzle/` | Esquema D1 y migraciones (aplicarlas en orden). |
| `contracts/` | Contrato de vouchers onchain: fase 2, no desplegado ni auditado. |
| `tests/` | Pruebas de los handlers sobre `node:sqlite` con las migraciones reales. |

## Comandos

```bash
npm ci
npm test           # 27 pruebas de dinero y seguridad
npm run typecheck
npm run lint
npm run build      # artefacto del Worker en dist/
npm start          # Worker local con D1 local (variables en dist/server/.dev.vars)
```

Base local: `npm run build` y luego, por cada archivo de `drizzle/` en orden:

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_rare_iron_man.sql
```

## Variables de entorno (secretos del hosting, nunca en el repo)

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `MERCHANT_ADDRESS` | sí, para vender | Wallet que recibe los pagos en U. |
| `INFERENCE_API_KEY` | sí, para redimir | Clave del proveedor (OpenRouter por defecto). |
| `INFERENCE_API_URL` | no | Base OpenAI-compatible; por defecto `https://openrouter.ai/api/v1`. |
| `INFERENCE_MODEL_MAP` | no | JSON `{"oferta":"proveedor/modelo"}` para cambiar el modelo de una oferta sin redeploy de código. |
| `FACILITATOR_URL` | no | Por defecto `https://api.x402.unibase.com/v2`. |
| `PUBLIC_HOST` | no | Host que deben nombrar las firmas de redención; por defecto el del request. Fijarlo si hay proxy delante. |
| `VOUCHER_CONTRACT_ADDRESS` | no | Solo informativo hasta la fase 2. |

## Reglas de dinero

**Compra (`POST /api/reservations`)**
- Sin `PAYMENT-SIGNATURE` responde 402 con los requisitos x402 v2.
- Se valida que la autorización EIP-3009 firmada pague el monto exacto, al receptor correcto, desde el comprador declarado y dentro de su ventana de validez, además del eco `accepted`.
- El nonce EIP-3009 se reserva en la tabla `payments` **antes** de llamar al facilitador: dos envíos simultáneos del mismo pago no llegan los dos a liquidar.
- El voucher se emite solo tras una liquidación correcta, y la emisión es idempotente: si el Worker muere entre liquidar y emitir, reenviar el mismo pago emite el voucher sin cobrar otra vez.
- Si el facilitador no responde al liquidar, el pago queda `pending` y no se reintenta solo (ver "Conciliación").

**Redención (`POST /api/redeem`)**, protocolo v2 (`lib/protocol.ts`)
- La firma cubre dominio, chain ID, voucher, oferta, SHA-256 del prompt, tope de unidades, nonce de un solo uso y caducidad de 10 minutos como máximo. Una firma capturada no se puede reenviar ni usar en otro despliegue.
- El nonce se marca usado antes de mover saldo; luego se reserva el tope firmado con un `UPDATE` condicional.
- Se cobra `prompt_tokens + completion_tokens` informados por el proveedor, nunca más que el tope firmado. Si el proveedor no informa uso, se cobra el tope completo. Si falla, se devuelve toda la reserva.
- Cada oferta se sirve con su propio modelo: un pase de DeepSeek no puede responderse con Llama.

## Lo que falta, sin adornos

- **Nada de esto se probó contra la red real.** Las pruebas usan un facilitador simulado que verifica firmas pero no liquida, y un proveedor simulado. Hace falta una compra real en BSC Testnet con una wallet de prueba con U, y una redención real contra OpenRouter.
- **Conciliación.** Un pago `pending` con error `settlement_outcome_unknown` necesita que alguien compruebe en la cadena (`authorizationState(payer, nonce)` del token U) si se cobró, y lo pase a `settled` o `failed`. Hoy es manual (consulta SQL a D1).
- **Redenciones colgadas.** Si el Worker muere a mitad de una inferencia, la reserva queda descontada y la fila en `pending`. Falta un barrido periódico que devuelva reservas `pending` antiguas.
- **Precios.** Con precios públicos aproximados de OpenRouter, 50.000 tokens de Llama 3.3 70B o 100.000 de DeepSeek R1 cuestan más de lo que se cobra en U. En testnet da igual; antes de mainnet hay que repreciar.
- **Consulta de vouchers pública por dirección.** Cualquiera puede ver el inventario de una wallet. Es aceptable en testnet (los pagos ya son públicos en la cadena), no para mainnet.
- **Despliegue fuera de ChatGPT Sites.** Para Cloudflare propio hace falta un `wrangler.jsonc` con el ID real de D1; el `wrangler.json` generado usa un ID de relleno.
- `components/ui/` trae componentes del starter que el sitio no usa.
