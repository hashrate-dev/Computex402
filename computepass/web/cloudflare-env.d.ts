declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    MERCHANT_ADDRESS?: string;
    FACILITATOR_URL?: string;
    /** OpenAI-compatible base URL; defaults to https://openrouter.ai/api/v1. */
    INFERENCE_API_URL?: string;
    INFERENCE_API_KEY?: string;
    /** Optional JSON {"offer-id":"provider/model"} overriding lib/catalog.ts. */
    INFERENCE_MODEL_MAP?: string;
    /** Host redemption signatures must name; defaults to the request host. */
    PUBLIC_HOST?: string;
    VOUCHER_CONTRACT_ADDRESS?: string;
    /** JSON-RPC for payment reconciliation; defaults to a public BSC testnet node. */
    BSC_RPC_URL?: string;
    /** Bearer token (32+ chars) for POST /api/admin/maintenance; unset disables it. */
    ADMIN_TOKEN?: string;
  }
}
