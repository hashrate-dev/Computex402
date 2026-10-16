import { createHash } from "node:crypto";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/fetch";
import { B402ExactClientScheme } from "@bnb-chain/b402/client";
import { fromAtomic, toAtomic, type Config } from "./config.js";
import { BudgetError, Ledger } from "./ledger.js";

/**
 * Client for the ComputePass 402 HTTP API (documented in /api/openapi).
 *
 * Field names below follow the project document (section 15). Where the
 * document does not pin a name, the choice is marked "ASSUMED" so it is easy
 * to align once the backend source is available.
 */

export interface Offer {
  id: string;
  model: string;
  provider?: string;
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
  expiresAt?: string;
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
const pick = (o: Obj, ...keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);
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
  const units = asNum(pick(o, "units", "capacityUnits", "capacity", "maxUnits", "outputUnits")) ?? 0;
  const priceField = pick(o, "price", "priceU", "amount", "priceAmount");
  const price = asNum(typeof priceField === "object" ? pick(priceField as Obj, "amount", "value") : priceField) ?? NaN;
  const latency = pick(o, "latencyMs", "targetLatencyMs", "latency", "sla");
  return {
    id: String(pick(o, "id", "offerId", "slug")),
    model: String(pick(o, "model", "modelName", "name") ?? "unknown"),
    provider: pick(o, "provider", "providerName") as string | undefined,
    units,
    price,
    latencyMs: typeof latency === "string" && /s$/.test(latency.trim()) && !/ms$/.test(latency) ? asNum(latency)! * 1000 : asNum(latency),
    validityDays: asNum(pick(o, "validityDays", "durationDays", "validDays")),
    pricePerKUnits: units > 0 ? (price / units) * 1000 : Infinity,
    raw: o,
  };
}

export function normalizeVoucher(v: Obj): Voucher {
  return {
    id: String(pick(v, "id", "voucherId")),
    offerId: pick(v, "offerId", "offer") as string | undefined,
    owner: pick(v, "owner", "ownerAddress") as string | undefined,
    totalUnits: asNum(pick(v, "totalUnits", "units")),
    remainingUnits: asNum(pick(v, "remainingUnits", "remaining", "balance")) ?? 0,
    status: String(pick(v, "status") ?? "unknown"),
    expiresAt: pick(v, "expiresAt", "expiry", "validUntil") as string | undefined,
    txHash: pick(v, "txHash", "settlementTxHash", "transaction") as string | undefined,
    raw: v,
  };
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Exact message the backend verifies (project document, section 11). */
export function redemptionMessage(voucherId: string, promptSha256: string, units: number): string {
  return `ComputePass redemption\nVoucher: ${voucherId}\nPrompt SHA-256: ${promptSha256}\nUnits: ${units}`;
}

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
    const capAtomic = toAtomic(Math.min(maxPerPurchase, this.ledger.budgetStatus().remainingToday), this.cfg.assetDecimals);
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
        // ASSUMED field names: offerId + owner (the buyer wallet the payer must match).
        body: JSON.stringify({ offerId, owner: account.address }),
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

  /** Redeem inference from a voucher; signs the owner message locally. */
  async redeem(voucherId: string, prompt: string, maxUnits: number) {
    const account = this.#requireAccount();
    if (!prompt.trim() || prompt.length > 16000) throw new Error("prompt must be 1..16000 characters");
    if (!Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > Math.min(4096, this.cfg.budget.maxUnitsPerRedeem)) {
      throw new BudgetError(`maxUnits must be an integer in 1..${Math.min(4096, this.cfg.budget.maxUnitsPerRedeem)}`);
    }
    const promptSha256 = sha256Hex(prompt);
    const signature = await account.signMessage({ message: redemptionMessage(voucherId, promptSha256, maxUnits) });
    try {
      // ASSUMED field names: voucherId, prompt, maxTokens, signature (+ owner for convenience).
      const body = (await this.#json("POST", "/api/redeem", {
        voucherId,
        prompt,
        maxTokens: maxUnits,
        signature,
        owner: account.address,
      })) as Obj;
      const out = {
        output: String(pick(body, "output", "result", "content", "text") ?? ""),
        model: pick(body, "model") as string | undefined,
        unitsUsed: asNum(pick(body, "unitsUsed", "consumedUnits", "consumed", "usage")),
        remainingUnits: asNum(pick(body, "remainingUnits", "remaining")),
        redemptionId: pick(body, "redemptionId", "id") as string | undefined,
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
