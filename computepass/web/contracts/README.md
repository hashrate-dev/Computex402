# ComputePassVoucher

Registro onchain de capacidad para BSC Testnet (chain ID 97). El despliegue
requiere que el usuario firme con la wallet que será `owner` inicial.

Después del despliegue:

1. Configurar como `issuer` la cuenta que emite vouchers tras liquidar x402.
2. Configurar como `redeemer` la cuenta que confirma consumos del endpoint.
3. Guardar la dirección desplegada como `VOUCHER_CONTRACT_ADDRESS`.

La aplicación usa vouchers persistentes aun si el contrato no está activado;
el estado de infraestructura muestra explícitamente esa diferencia.

## Estado (2026-10-16)

No desplegado ni auditado. El MVP usa el registro offchain en D1 y no depende
de este contrato. Antes de activarlo:

- `transferVoucher` cambia el dueño onchain, pero el backend redime contra el
  dueño guardado en D1: hoy un traspaso onchain no se refleja y las dos fuentes
  divergen. Hay que elegir una sola fuente de verdad.
- `redeem` confía por completo en la cuenta `redeemer`: no verifica ninguna
  firma del titular. Una clave de redeemer filtrada puede vaciar cualquier pase.
- No hay pausa de emergencia ni límites por bloque.
