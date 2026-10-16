import type { Offer, Voucher } from "./api.js";
import type { Config } from "./config.js";

export interface Need {
  units: number; // units the job needs
  model?: string; // substring match, e.g. "llama" or "deepseek"
  maxLatencyMs?: number;
}

export interface Quote {
  offer: Offer;
  passesNeeded: number;
  cost: number; // U
  withinBudget: boolean;
  reason?: string;
}

const modelMatches = (offer: Offer, model?: string) =>
  !model || `${offer.model} ${offer.id}`.toLowerCase().includes(model.toLowerCase());

/** Price every offer for a need, cheapest first; offers that cannot serve it are dropped. */
export function quote(offers: Offer[], need: Need, cfg: Config, remainingToday: number): Quote[] {
  const b = cfg.budget;
  return offers
    .filter((o) => o.units > 0 && Number.isFinite(o.price))
    .filter((o) => modelMatches(o, need.model))
    .filter((o) => !need.maxLatencyMs || !o.latencyMs || o.latencyMs <= need.maxLatencyMs)
    .map((offer) => {
      const passesNeeded = Math.ceil(need.units / offer.units);
      const cost = passesNeeded * offer.price;
      let reason: string | undefined;
      if (b.allowedOffers && !b.allowedOffers.includes(offer.id)) reason = "offer not allowlisted";
      else if (b.allowedModels && !b.allowedModels.some((m) => offer.model.toLowerCase().includes(m.toLowerCase())))
        reason = "model not allowlisted";
      else if (offer.price > b.maxPerPurchase) reason = `price above per-purchase cap ${b.maxPerPurchase} U`;
      else if (cost > remainingToday) reason = `cost above remaining daily budget ${remainingToday} U`;
      return { offer, passesNeeded, cost, withinBudget: !reason, reason };
    })
    .sort((a, b2) => Number(b2.withinBudget) - Number(a.withinBudget) || a.cost - b2.cost || a.offer.pricePerKUnits - b2.offer.pricePerKUnits);
}

/** An active, unexpired voucher with enough balance for `units`, preferring the one closest to expiry. */
export function usableVoucher(vouchers: Voucher[], offers: Offer[], need: Need): Voucher | undefined {
  const now = Date.now();
  return vouchers
    .filter((v) => v.status === "active" && v.remainingUnits >= need.units)
    .filter((v) => !v.expiresAt || Date.parse(v.expiresAt) > now)
    .filter((v) => {
      const offer = offers.find((o) => o.id === v.offerId);
      return !need.model || !offer || modelMatches(offer, need.model);
    })
    .sort((a, b) => Date.parse(a.expiresAt ?? "9999") - Date.parse(b.expiresAt ?? "9999"))[0];
}
