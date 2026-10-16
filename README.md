# ComputeX402

Agentes que venden y compran cómputo/inferencia en BNB Chain cobrando por x402.

| Carpeta | Qué es |
| --- | --- |
| [`computepass/web/`](computepass/web/) | ComputePass 402: sitio y API (Next/vinext en Cloudflare Workers + D1). Compra de vouchers con x402 y redención de inferencia firmada por la wallet. |
| [`computepass/agent/`](computepass/agent/) | Servidor MCP, agente de referencia, agente con LLM vía OpenRouter y pasarela OpenAI-compatible que consumen la API de `web/`. Plan en [PLAN.md](computepass/PLAN.md). |
| [`computeseller/`](computeseller/) | Agente vendedor creado con BNB Agent Studio (`bag`): cobra x402 en BSC testnet por tareas de cómputo acotadas. Notas en [COMPUTEX402.md](computeseller/COMPUTEX402.md). |

Los secretos (claves de wallet, keystores, `.studio/`, `.env*`, claves de OpenRouter) nunca se suben: van en variables de entorno o en `.studio/` local.
