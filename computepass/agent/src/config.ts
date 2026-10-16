import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * Runtime configuration, read from the environment.
 *
 * The buyer key never reaches a model: the MCP server and the agent only
 * expose tool results, and every payment passes the budget checks first.
 */
export interface Config {
  apiUrl: string;
  network: string; // CAIP-2, e.g. eip155:97
  paymentAsset: `0x${string}`;
  assetDecimals: number;
  account?: PrivateKeyAccount;
  budget: {
    maxPerPurchase: number; // in token units (U), not atomic
    maxPerDay: number;
    maxUnitsPerRedeem: number;
    allowedOffers?: string[];
    allowedModels?: string[];
  };
  stateDir: string;
}

function list(v: string | undefined): string[] | undefined {
  const items = v?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid number: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const key = env.BUYER_PRIVATE_KEY?.trim();
  return {
    apiUrl: (env.COMPUTEPASS_API_URL ?? "https://computepass-402.fabrianchi.chatgpt.site").replace(/\/+$/, ""),
    network: env.COMPUTEPASS_NETWORK ?? "eip155:97",
    paymentAsset: (env.COMPUTEPASS_ASSET ?? "0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565") as `0x${string}`,
    assetDecimals: num(env.COMPUTEPASS_ASSET_DECIMALS, 18),
    account: key ? privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`) : undefined,
    budget: {
      maxPerPurchase: num(env.BUDGET_MAX_PER_PURCHASE, 0.05),
      maxPerDay: num(env.BUDGET_MAX_PER_DAY, 0.2),
      maxUnitsPerRedeem: num(env.BUDGET_MAX_UNITS_PER_REDEEM, 4096),
      allowedOffers: list(env.BUDGET_ALLOWED_OFFERS),
      allowedModels: list(env.BUDGET_ALLOWED_MODELS),
    },
    stateDir: env.COMPUTEPASS_STATE_DIR ?? ".computepass",
  };
}

/** Decimal token amount -> atomic integer string, exact (no float math). */
export function toAtomic(amount: number | string, decimals: number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function fromAtomic(atomic: bigint | string, decimals: number): number {
  return Number(BigInt(atomic)) / 10 ** decimals;
}
