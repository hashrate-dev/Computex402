# ComputePass 402: diagnóstico y plan del hito 28

> **Actualización 2026-10-16 (tarde).** El código del sitio ya está en [`web/`](web/). Resuelto ahí: riesgo 3 (firma v2 con dominio, oferta, nonce y caducidad), riesgo 4 (un modelo por oferta), riesgo 7 (se cobran tokens de entrada + salida), compra x402 idempotente con el nonce reservado antes de liquidar, y el botón de compra del sitio, que fallaba porque el cliente x402 rechaza el token U sin `spendControls`. El agente y el MCP usan la API real (tareas 1, 2 y 5 hechas). Sigue pendiente: 3 (API pública), 4 (configurar secretos), 6 (compra real en testnet) y 7 (demo). Detalle en [`web/README.md`](web/README.md).

Fecha: 2026-10-16. Autor: Claude (rol CEO/CTO pedido por Hash).

## Diagnóstico honesto

**Lo que no puedo ver.** El código de ComputePass 402 no está en ningún sitio al que tenga acceso: no está en `hashrate-dev/Computex402` (solo contiene el zip del agente vendedor `bag`), ni en `~/Claude` del Mac, ni en la carpeta del proyecto. El sitio `computepass-402.fabrianchi.chatgpt.site` está bloqueado por la política de red de este entorno (y el documento dice que la URL es privada). Todo lo que digo del backend sale del documento, no del código.

**Riesgos y supuestos débiles, por orden de gravedad:**

1. **Dos productos compitiendo por el mismo sprint.** ComputeX402 (agente `bag` que vende primos y matrices a $0.05) y ComputePass (vouchers de inferencia) no se tocan. Nadie paga por calcular primos. Recomiendo: ComputePass es el producto; ComputeX402 queda como experimento archivado.
2. **Una URL privada no sirve para agentes.** Si un agente de un tercero no puede hacer `GET /api/offers` sin login, el hito 28 no se puede demostrar. El backend tiene que ser público (al menos `/api/*`).
3. **Firma de redención reproducible (bug de seguridad).** El mensaje `Voucher + SHA-256 + Units` no lleva nonce, caducidad ni dominio. Cualquiera que vea una firma (logs, proxy, extensión del navegador) puede reenviarla y vaciar el voucher repitiendo el mismo prompt, y además recibe la respuesta. Arreglo: añadir `Nonce` y `Expires` al mensaje y guardar los nonces usados en D1 con índice único. Si me pasas el código lo arreglo yo.
4. **Un solo `INFERENCE_MODEL` para dos ofertas.** El catálogo vende Llama 3.3 70B y DeepSeek R1, pero el backend usa un único modelo por variable de entorno. Quien compre DeepSeek puede recibir Llama. Hace falta un mapa `offer → modelo` del proveedor.
5. **Precios con margen negativo si algún día va a mainnet.** Con precios públicos típicos (Llama 3.3 70B ≈ $0.3–0.9 por millón de tokens de salida, R1 ≈ $2 por millón; cifras aproximadas, no verificadas hoy), 50.000 tokens de Llama cuestan $0.015–0.045 y se venden a 0,01 U, y 100.000 de R1 cuestan unos $0.2 y se venden a 0,018 U. En testnet da igual; antes de mainnet hay que repreciar.
6. **Dependencia del facilitador de Unibase y del token "U".** Hay que comprobar con una compra real que `api.x402.unibase.com/v2` soporta `eip155:97` + U testnet en modo `exact/eip3009`. Hasta entonces la compra x402 es "implementada en código", no "funciona". Además, B402 exige `extra.signerAddress` en el 402; el backend tiene que enviarlo.
7. **"Unidades" = tokens máximos de salida** ignora los tokens de entrada. Un prompt de 16.000 caracteres (~4.000 tokens) se paga gratis. Contar `prompt_tokens + completion_tokens` del proveedor.

## Decisiones que propongo (por defecto, salvo que digas otra cosa)

- **Voucher offchain en el MVP.** El contrato no aporta nada al comprador hoy y exige auditoría. Se mantiene el registro D1 y el comprobante firmado; el contrato pasa a la fase 2.
- **Proveedor de inferencia: OpenRouter** (una sola clave, interfaz OpenAI, tiene Llama 3.3 70B y DeepSeek R1). Alternativas: Together, DeepInfra, Groq.
- **El agente de referencia y el MCP usan la API documentada** (`/api/offers`, `/api/reservations`, `/api/vouchers`, `/api/redeem`) con el cliente oficial `@x402/fetch` + `@bnb-chain/b402`, igual que el sitio.

## Plan priorizado del hito 28

| # | Tarea | Quién | Bloqueado por |
|---|---|---|---|
| 1 | Servidor MCP con las 6 herramientas | Claude | nada (hecho contra la API documentada) |
| 2 | Agente de referencia: descubre, compara, compra dentro de presupuesto, redime, emite comprobante | Claude | nada |
| 3 | Hacer pública la API y pasarme el código fuente | Hash | — |
| 4 | Configurar `MERCHANT_ADDRESS`, `INFERENCE_API_URL/KEY`, mapa de modelos | Hash + Claude | wallet receptora y clave del proveedor |
| 5 | Arreglar firma de redención (nonce + caducidad) y conteo de tokens | Claude | código fuente |
| 6 | Compra x402 real en testnet con una wallet de prueba con U | Claude | tu permiso + U testnet en la wallet |
| 7 | Demo grabada de extremo a extremo | Claude | 3–6 |
