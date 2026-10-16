import { env } from "cloudflare:workers";
import { isAddress } from "viem";
import { CHAIN_ID, DEFAULT_FACILITATOR, NETWORK, U_TOKEN } from "@/lib/catalog";
import { REDEMPTION_VERSION } from "@/lib/protocol";

export async function GET() {
  return Response.json(
    {
      network: NETWORK,
      chainId: CHAIN_ID,
      chainName: "BSC Testnet",
      asset: U_TOKEN,
      facilitator: env.FACILITATOR_URL || DEFAULT_FACILITATOR,
      redemptionProtocol: REDEMPTION_VERSION,
      ready: {
        payment: Boolean(env.MERCHANT_ADDRESS && isAddress(env.MERCHANT_ADDRESS)),
        inference: Boolean(env.INFERENCE_API_KEY),
        contract: Boolean(env.VOUCHER_CONTRACT_ADDRESS),
      },
      contractAddress: env.VOUCHER_CONTRACT_ADDRESS || null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
