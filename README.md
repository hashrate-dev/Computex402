# ComputeX402

Agentes que venden y compran cómputo/inferencia en BNB Chain cobrando por x402.

| Carpeta | Qué es |
| --- | --- |
| [`computepass/`](computepass/) | ComputePass 402: plan ([PLAN.md](computepass/PLAN.md)) y [`agent/`](computepass/agent/) con servidor MCP, agente de referencia, agente con LLM vía OpenRouter, pasarela OpenAI-compatible y un mock del backend para pruebas. |
| [`computeseller/`](computeseller/) | Agente vendedor creado con BNB Agent Studio (`bag`): cobra x402 en BSC testnet por tareas de cómputo acotadas. Notas en [COMPUTEX402.md](computeseller/COMPUTEX402.md). |

Los secretos (claves de wallet, keystores, `.studio/`, `.env*`, claves de OpenRouter) nunca se suben: van en variables de entorno o en `.studio/` local.
