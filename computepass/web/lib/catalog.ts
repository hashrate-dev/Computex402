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
 */
export const offers = [
  {
    id: "llama-70b-burst",
    model: "Llama 3.3 70B",
    upstreamModel: "meta-llama/llama-3.3-70b-instruct",
    provider: "ComputePass Pool",
    units: 50_000,
    priceAtomic: "10000000000000000",
    priceLabel: "0,01 U",
    decimals: U_DECIMALS,
    latency: "< 1,8 s",
    latencyMs: 1_800,
    expiresInDays: 30,
  },
  {
    id: "deepseek-r1-flex",
    model: "DeepSeek R1",
    upstreamModel: "deepseek/deepseek-r1",
    provider: "ComputePass Pool",
    units: 100_000,
    priceAtomic: "18000000000000000",
    priceLabel: "0,018 U",
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
