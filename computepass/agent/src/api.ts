import { createHash, randomBytes } from "node:crypto";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/fetch";
import { B402ExactClientScheme } from "@bnb-chain/b402/client";
import { fromAtomic, toAtomic, type Config } from "./config.js";
import { BudgetError, Ledger } from "./ledger.js";
import { CHAIN_ID, MAX_REDEMPTION_UNITS, REDEMPTION_MAX_TTL_SECONDS, redemptionMessage } from "../../web/lib/protocol.js";

/**
 * Client for the ComputePass 402 HTTP API (computepass/web, documented in
 * /api/openapi). The redemption message comes from web/lib/protocol.ts, the
 * same file the backend verifies against.
 */

export interface Offer {
  id: string;
  model: string;
  provider?: string;
  upstreamModel?: string;
  units: number;
  price: number; // U per pass
  latencyMs?: number;
  validityDays?: number;
  pricePerKUnits: number;
  raw: unknown;
}

export interface Voucher {
  id: string;
  offerId?: string;
  owner?: string;
  totalUnits?: number;
  remainingUnits: number;
  status: string;
  expiresAt?: string; // ISO 8601
  txHash?: string;
  raw: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;
const asNum = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};
const unwrapList = (body: unknown, key: string): Obj[] =>
  (Array.isArray(body) ? body : ((body as Obj)?.[key] ?? (body as Obj)?.data ?? [])) as Obj[];

export function normalizeOffer(o: Obj): Offer {
  const units = asNum(o.units) ?? 0;
  // Price comes from the exact atomic amount; priceLabel ("0,01 U") is display-only.
  const decimals = asNum(o.decimals) ?? 18;
  const price = typeof o.priceAtomic === "string" && /^\d+$/.test(o.priceAtomic) ? fromAtomic(o.priceAtomic, decimals) : NaN;
  return {
    id: String(o.id),
    model: String(o.model ?? "unknown"),
    provider: o.provider as string | undefined,
    upstreamModel: o.upstreamModel as string | undefined,
    units,
    price,
    latencyMs: typeof o.latencyMs === "number" ? o.latencyMs : undefined,
    validityDays: asNum(o.expiresInDays),
    pricePerKUnits: units > 0 ? (price / units) * 1000 : Infinity,
    raw: o,
  };
}

export function normalizeVoucher(v: Obj): Voucher {
  return {
    id: String(v.id),
    offerId: v.offerId as string | undefined,
    owner: v.ownerAddress as string | undefined,
    totalUnits: asNum(v.totalUnits),
    remainingUnits: asNum(v.remainingUnits) ?? 0,
    status: String(v.status ?? "unknown"),
    // The API returns Unix seconds.
    expiresAt: typeof v.expiresAt === "number" ? new Date(v.expiresAt * 1000).toISOString() : undefined,
    txHash: v.paymentTx as string | undefined,
    raw: v,
  };
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");


export class ComputePassClient {
  constructor(
    readonly cfg: Config,
    readonly ledger: Ledger,
    private readonly http: typeof fetch = fetch,
  ) {}

  get address(): string | undefined {
    return this.cfg.account?.address;
  }

  async status(): Promise<unknown> {
    return this.#json("GET", "/api/status");
  }

  async offers(): Promise<Offer[]> {
    return unwrapList(await this.#json("GET", "/api/offers"), "offers").map(normalizeOffer);
  }

  async vouchers(owner = this.address): Promise<Voucher[]> {
    if (!owner) throw new Error("owner address required (set BUYER_PRIVATE_KEY or pass owner)");
    const body = await this.#json("GET", `/api/vouchers?owner=${encodeURIComponent(owner)}`);
    return unwrapList(body, "vouchers").map(normalizeVoucher);
  }

  /** Buy one pass of `offerId` through x402, inside the budget. */
  async buy(offerId: string) {
    const account = this.#requireAccount();
    const offer = (await this.offers()).find((o) => o.id === offerId);
    if (!offer) throw new ApiError(404, null, `offer not found: ${offerId}`);
    // Check with the advertised price before talking to the payment layer at all.
    if (Number.isFinite(offer.price)) this.ledger.assertCanBuy(offer.id, offer.model, offer.price);

    const { maxPerPurchase } = this.cfg.budget;
    // Never pay more than the advertised price, nor more than the budget allows.
    const budgetAtomic = toAtomic(Math.min(maxPerPurchase, this.ledger.budgetStatus().remainingToday), this.cfg.assetDecimals);
    const advertised = (offer.raw as Obj).priceAtomic;
    const capAtomic = typeof advertised === "string" && /^\d+$/.test(advertised) && BigInt(advertised) < budgetAtomic ? BigInt(advertised) : budgetAtomic;
    let selected: PaymentRequirements | undefined;
    const payments = new x402Client()
      .register(this.cfg.network as `${string}:${string}`, new B402ExactClientScheme({ account, methods: ["eip3009"] }))
      .setSpendControls({
        maxAmountPerPayment: false,
        allowedAssets: [{ network: this.cfg.network as `${string}:${string}`, asset: this.cfg.paymentAsset, maxAmountPerPayment: capAtomic.toString() }],
      })
      .registerPolicy((_v, reqs) => {
        const ok = reqs.filter(
          (r) =>
            r.network === this.cfg.network &&
            r.asset.toLowerCase() === this.cfg.paymentAsset.toLowerCase() &&
            BigInt(r.amount) <= capAtomic,
        );
        selected = ok[0];
        return ok;
      });
    const paidFetch = wrapFetchWithPayment(this.http, payments);

    let res: Response;
    try {
      res = await paidFetch(this.#url("/api/reservations"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offerId, buyer: account.address }),
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (/spendControls|rejected|No payment requirements/i.test(msg)) throw new BudgetError(`payment refused by budget: ${msg}`);
      throw e;
    }
    const body = await res.json().catch(() => null);
    if (res.status !== 201 && res.status !== 200) {
      throw new ApiError(res.status, body, `purchase failed (${res.status}): ${JSON.stringify(body)}`);
    }
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") ?? "") as Obj | undefined;
    const voucher = normalizeVoucher(((body as Obj)?.voucher ?? body) as Obj);
    const paid = selected ? fromAtomic(selected.amount, this.cfg.assetDecimals) : offer.price;
    const record = this.ledger.addPurchase({
      offerId,
      amount: paid,
      voucherId: voucher.id,
      txHash: (settle?.transaction as string) ?? voucher.txHash,
      payer: account.address,
    });
    return { voucher, settlement: settle, paid, receiptId: record.id };
  }

  /**
   * Redeem inference from a voucher; signs the v2 owner message locally.
   * `maxUnits` caps prompt + completion tokens; the backend bills real usage.
   */
  async redeem(voucherId: string, prompt: string, maxUnits: number) {
    const account = this.#requireAccount();
    const text = prompt.trim();
    if (!text || text.length > 16000) throw new Error("prompt must be 1..16000 characters");
    const cap = Math.min(MAX_REDEMPTION_UNITS, this.cfg.budget.maxUnitsPerRedeem);
    if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > cap) {
      throw new BudgetError(`maxUnits must be an integer in 1..${cap}`);
    }
    const voucher = (await this.vouchers()).find((v) => v.id === voucherId);
    if (!voucher?.offerId) throw new ApiError(404, null, `voucher not found for this wallet: ${voucherId}`);
    const promptSha256 = sha256Hex(text);
    const intent = {
      domain: new URL(this.cfg.apiUrl).host,
      chainId: CHAIN_ID,
      voucherId,
      offerId: voucher.offerId,
      promptSha256,
      maxUnits,
      nonce: `0x${randomBytes(32).toString("hex")}`,
      expiresAt: Math.floor(Date.now() / 1000) + REDEMPTION_MAX_TTL_SECONDS - 60,
    };
    const signature = await account.signMessage({ message: redemptionMessage(intent) });
    try {
      const body = (await this.#json("POST", "/api/redeem", {
        voucherId,
        offerId: intent.offerId,
        address: account.address,
        prompt: text,
        maxUnits,
        nonce: intent.nonce,
        expiresAt: intent.expiresAt,
        signature,
      })) as Obj;
      const usage = (body.usage ?? {}) as Obj;
      const out = {
        output: String(body.output ?? ""),
        model: body.model as string | undefined,
        unitsUsed: asNum(body.usedUnits),
        promptTokens: asNum(usage.promptTokens),
        completionTokens: asNum(usage.completionTokens),
        remainingUnits: asNum(body.remainingUnits),
        redemptionId: body.redemptionId as string | undefined,
      };
      const record = this.ledger.addRedemption({
        voucherId,
        redemptionId: out.redemptionId,
        promptSha256,
        model: out.model,
        unitsUsed: out.unitsUsed,
        remaining: out.remainingUnits,
        status: "completed",
      });
      return { ...out, receiptId: record.id };
    } catch (e) {
      this.ledger.addRedemption({ voucherId, promptSha256, status: "failed", error: (e as Error).message });
      throw e;
    }
  }

  #requireAccount() {
    if (!this.cfg.account) throw new Error("BUYER_PRIVATE_KEY is not set: buying and redeeming are disabled");
    return this.cfg.account;
  }

  #url(path: string) {
    return `${this.cfg.apiUrl}${path}`;
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.http(this.#url(path), {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const msg = (parsed as Obj)?.error ?? (parsed as Obj)?.message ?? text.slice(0, 300);
      throw new ApiError(res.status, parsed, `${method} ${path} -> ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    }
    return parsed;
  }
}
