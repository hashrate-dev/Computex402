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
npm test           # pruebas de dinero, seguridad, mantenimiento y precios
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
| `ADMIN_TOKEN` | para el cron | Protege `POST /api/admin/maintenance`. |
| `BSC_RPC_URL` | no | RPC de BSC testnet para conciliar pagos. |

## Reglas de dinero

**Compra (`POST /api/reservations`)**
- Sin `PAYMENT-SIGNATURE` responde 402 con los requisitos x402 v2.
- Se valida que la autorización EIP-3009 firmada pague el monto exacto, al receptor correcto, desde el comprador declarado y dentro de su ventana de validez, además del eco `accepted`.
- El nonce EIP-3009 se reserva en la tabla `payments` **antes** de llamar al facilitador: dos envíos simultáneos del mismo pago no llegan los dos a liquidar.
- El voucher se emite solo tras una liquidación correcta, y la emisión es idempotente: si el Worker muere entre liquidar y emitir, reenviar el mismo pago emite el voucher sin cobrar otra vez.
- Si el facilitador no responde al liquidar, el pago queda `pending` y no se reintenta solo; el mantenimiento lo concilia con la cadena.

**Redención (`POST /api/redeem`)**, protocolo v2 (`lib/protocol.ts`)
- La firma cubre dominio, chain ID, voucher, oferta, SHA-256 del prompt, tope de unidades, nonce de un solo uso y caducidad de 10 minutos como máximo. Una firma capturada no se puede reenviar ni usar en otro despliegue.
- El nonce se marca usado antes de mover saldo; luego se reserva el tope firmado con un `UPDATE` condicional.
- Se cobra `prompt_tokens + completion_tokens` informados por el proveedor, nunca más que el tope firmado. Si el proveedor no informa uso, se cobra el tope completo. Si falla, se devuelve toda la reserva.
- Cada oferta se sirve con su propio modelo: un pase de DeepSeek no puede responderse con Llama.

## Mantenimiento (cron)

`POST /api/admin/maintenance` con `Authorization: Bearer $ADMIN_TOKEN` (32+ caracteres; sin `ADMIN_TOKEN` el endpoint no existe). Llamarlo cada 5–10 minutos desde cualquier cron:

- **Redenciones colgadas:** si el Worker murió a mitad de una inferencia, a los 15 minutos devuelve la reserva al voucher. Es atómico y solo aplica a filas `pending`, así que una respuesta tardía nunca devuelve dos veces.
- **Conciliación de pagos:** para pagos `pending` con más de 10 minutos, consulta `authorizationState(payer, nonce)` del token U en BSC testnet (`BSC_RPC_URL`). Si la autorización se consumió, el comprador pagó: se marca `settled`, se busca el tx en los logs `AuthorizationUsed` y se emite el voucher. Si no se consumió y venció su `validBefore`, se marca `failed` y el comprador puede pagar de nuevo.

## Precios

Cada oferta guarda el precio de lista del proveedor (`upstreamUsdPerMTok`, leído de OpenRouter el 2026-10-16) y `tests/catalog.test.ts` exige que el pase cueste al menos 1,5 veces su peor caso (todo en tokens de salida), suponiendo 1 U = 1 USD.

| Oferta | Unidades | Peor costo | Precio | Margen |
| --- | --- | --- | --- | --- |
| Llama 3.3 70B | 50.000 | 0,016 USD | 0,025 U | 1,56x |
| DeepSeek R1 | 20.000 | 0,050 USD | 0,08 U | 1,6x |

El pase de R1 bajó de 100.000 a 20.000 unidades: a 0,018 U se perdían unos 0,23 USD por pase.

## Compra real en testnet con un comando

```bash
computepass/scripts/testnet-demo.sh 0xTuDireccionReceptora [offerId]
```

Compila, aplica las migraciones locales que falten, arranca el Worker en `127.0.0.1:8788` con esa dirección y compra un pase con una wallet de prueba cuya clave queda en `~/.computepass/testnet-buyer.key` (fuera del repo). Si la wallet no tiene U, imprime la dirección a fondear y no firma nada. No hace falta tBNB.

## Lo que falta, sin adornos

- **Todavía no hubo una compra real.** Las pruebas usan un facilitador y un proveedor simulados. El script de arriba es el paso que falta.
- **Supuestos sin verificar:** que el token U implementa `authorizationState` y `AuthorizationUsed` (estándar EIP-3009) y que 1 U = 1 USD.
- **Consulta de vouchers pública por dirección.** Aceptable en testnet, no en mainnet.
- **Despliegue fuera de ChatGPT Sites.** Para Cloudflare propio hace falta un `wrangler.jsonc` con el ID real de D1.
- `components/ui/` trae componentes del starter que el sitio no usa.
