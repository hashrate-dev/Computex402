export const NETWORK = "eip155:97";
export const CHAIN_ID = 97;
export const U_TOKEN = "0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565";
export const U_DECIMALS = 18;
export const DEFAULT_FACILITATOR = "https://api.x402.unibase.com/v2";
export const FACILITATOR_SIGNER = "0x2cFf062a030f148853aA1c8c12d680B9860Ef041";
export const DEFAULT_INFERENCE_API_URL = "https://openrouter.ai/api/v1";

/**
 * One unit = one token, prompt and completion alike, as reported by the
 * provider. `upstreamModel` is the provider model each offer is served with,
 * so a DeepSeek pass can never be served by Llama.
 *
 * `upstreamUsdPerMTok` is the provider list price (OpenRouter /api/v1/models,
 * read 2026-10-16). Prices are set so that a pass used entirely on completion
 * tokens (the expensive case) still leaves at least MIN_MARGIN, assuming
 * 1 U = 1 USD. tests/catalog.test.ts enforces it; re-read the provider price
 * before changing either number.
 */
export const MIN_MARGIN = 1.5;
export const offers = [
  {
    id: "llama-70b-burst",
    model: "Llama 3.3 70B",
    upstreamModel: "meta-llama/llama-3.3-70b-instruct",
    upstreamUsdPerMTok: { prompt: 0.1, completion: 0.32 },
    provider: "ComputePass Pool",
    units: 50_000,
    priceAtomic: "25000000000000000",
    priceLabel: "0,025 U",
    decimals: U_DECIMALS,
    latency: "< 1,8 s",
    latencyMs: 1_800,
    expiresInDays: 30,
  },
  {
    id: "deepseek-r1-flex",
    model: "DeepSeek R1",
    upstreamModel: "deepseek/deepseek-r1",
    upstreamUsdPerMTok: { prompt: 0.7, completion: 2.5 },
    provider: "ComputePass Pool",
    units: 20_000,
    priceAtomic: "80000000000000000",
    priceLabel: "0,08 U",
    decimals: U_DECIMALS,
    latency: "< 3,2 s",
    latencyMs: 3_200,
    expiresInDays: 30,
  },
] as const;

export type Offer = (typeof offers)[number];

export function getOffer(id: string): Offer | undefined {
  return offers.find((offer) => offer.id === id);
}

/** Provider model for an offer; INFERENCE_MODEL_MAP (JSON) may override per offer. */
export function upstreamModelFor(offer: Offer, modelMapJson?: string): string {
  if (modelMapJson) {
    try {
      const map = JSON.parse(modelMapJson) as Record<string, unknown>;
      const override = map[offer.id];
      if (typeof override === "string" && override.trim()) return override.trim();
    } catch {
      // A malformed override must not silently change the served model.
      throw new Error("INFERENCE_MODEL_MAP is not valid JSON");
    }
  }
  return offer.upstreamModel;
}
