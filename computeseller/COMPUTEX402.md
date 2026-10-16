# ComputeX402 — vendedor de cómputo con x402

Agente vendedor (BNB Agent Studio, `bag` 0.0.14) que cobra **$0.05 por petición** vía x402 (rail B402) en **bsc-testnet**.

## Qué vende
`POST /x402` con `{"prompt": "<spec JSON>"}`. Tareas (`app/agent/src/compute.ts`), cada una en un worker con límite de memoria (256 MB) y timeout (20 s):

| task | parámetro | máximo |
|---|---|---|
| primes | n | 50 000 000 |
| sha256_chain | rounds | 5 000 000 |
| matmul | size | 400 |
| monte_carlo_pi | samples | 200 000 000 |

Ejemplo: `{"prompt": "{\"task\":\"primes\",\"n\":10000000}"}` → `{"result": "{...\"primes\":664579...}"}`.
No ejecuta código del comprador; eso necesitaría un sandbox real (contenedor/microVM).

## Ejecutar
La carpeta compartida no admite symlinks, así que copia el proyecto a disco local antes de `pnpm install`:
```
cp -r /mnt/project-files/computex402/computeseller ~/work/ && cd ~/work/computeseller && pnpm install
cd app/agent && npx tsx scripts/smokeCompute.ts   # prueba el cómputo sin cartera
bag dev                                            # necesita cartera (bag wallet new) y WALLET_PASSWORD
```
Cobro real: cartera del agente + credenciales de comerciante B402 (4 variables en `.studio/.env.local`).
