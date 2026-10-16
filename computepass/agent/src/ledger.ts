import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

/**
 * Local spend ledger and execution receipts.
 *
 * This is the "delegated wallet" of the MVP: the agent may only spend inside
 * the caps in Config.budget, and every purchase and redemption is written down
 * so get_execution_receipt can prove what was bought and consumed.
 */

export interface PurchaseRecord {
  kind: "purchase";
  id: string;
  at: string;
  offerId: string;
  amount: number; // U
  voucherId?: string;
  txHash?: string;
  payer: string;
}

export interface RedemptionRecord {
  kind: "redemption";
  id: string;
  at: string;
  voucherId: string;
  redemptionId?: string;
  promptSha256: string;
  model?: string;
  unitsUsed?: number;
  remaining?: number;
  status: "completed" | "failed";
  error?: string;
}

export type LedgerRecord = PurchaseRecord | RedemptionRecord;

export class BudgetError extends Error {
  override name = "BudgetError";
}

export class Ledger {
  readonly #file: string;
  #records: LedgerRecord[];

  constructor(private readonly cfg: Config) {
    mkdirSync(cfg.stateDir, { recursive: true });
    this.#file = join(cfg.stateDir, "ledger.json");
    try {
      this.#records = JSON.parse(readFileSync(this.#file, "utf8"));
    } catch {
      this.#records = [];
    }
  }

  spentToday(now = new Date()): number {
    const day = now.toISOString().slice(0, 10);
    return this.#records
      .filter((r): r is PurchaseRecord => r.kind === "purchase" && r.at.startsWith(day))
      .reduce((s, r) => s + r.amount, 0);
  }

  /** Throws BudgetError when a purchase of `amount` U for this offer is not allowed. */
  assertCanBuy(offerId: string, model: string | undefined, amount: number): void {
    const b = this.cfg.budget;
    if (b.allowedOffers && !b.allowedOffers.includes(offerId)) {
      throw new BudgetError(`offer ${offerId} is not in BUDGET_ALLOWED_OFFERS`);
    }
    if (b.allowedModels && model && !b.allowedModels.some((m) => model.toLowerCase().includes(m.toLowerCase()))) {
      throw new BudgetError(`model ${model} is not in BUDGET_ALLOWED_MODELS`);
    }
    if (amount > b.maxPerPurchase) {
      throw new BudgetError(`price ${amount} U exceeds per-purchase cap ${b.maxPerPurchase} U`);
    }
    const spent = this.spentToday();
    if (spent + amount > b.maxPerDay) {
      throw new BudgetError(`daily cap ${b.maxPerDay} U would be exceeded (spent today ${spent} U)`);
    }
  }

  budgetStatus() {
    const spent = this.spentToday();
    return { ...this.cfg.budget, spentToday: spent, remainingToday: Math.max(0, this.cfg.budget.maxPerDay - spent) };
  }

  addPurchase(r: Omit<PurchaseRecord, "kind" | "id" | "at">): PurchaseRecord {
    return this.#add({ kind: "purchase", id: randomUUID(), at: new Date().toISOString(), ...r });
  }

  addRedemption(r: Omit<RedemptionRecord, "kind" | "id" | "at">): RedemptionRecord {
    return this.#add({ kind: "redemption", id: randomUUID(), at: new Date().toISOString(), ...r });
  }

  /** Receipt for a voucher: its purchase plus every redemption, with a content digest. */
  receipt(voucherId: string) {
    const records = this.#records.filter(
      (r) => (r.kind === "purchase" && r.voucherId === voucherId) || (r.kind === "redemption" && r.voucherId === voucherId),
    );
    const body = { voucherId, records };
    return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  }

  recent(limit = 20): LedgerRecord[] {
    return this.#records.slice(-limit);
  }

  #add<T extends LedgerRecord>(r: T): T {
    this.#records.push(r);
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#records, null, 2));
    renameSync(tmp, this.#file);
    return r;
  }
}
