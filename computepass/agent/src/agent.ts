#!/usr/bin/env node
import { ComputePassClient } from "./api.js";
import { loadConfig } from "./config.js";
import { Ledger } from "./ledger.js";
import { quote, usableVoucher, type Need } from "./planner.js";

/**
 * Reference agent: discovers offers, compares them, stays inside its budget,
 * pays via x402, redeems inference and prints a receipt. No human in the loop.
 *
 *   BUYER_PRIVATE_KEY=0x... npx tsx src/agent.ts "your prompt" [--units 512] [--model llama] [--max-latency 2000]
 */

function args(argv: string[]): { prompt: string; units: number; model?: string; maxLatencyMs?: number; dryRun: boolean } {
  const out: { prompt?: string; units: number; model?: string; maxLatencyMs?: number; dryRun: boolean } = {
    units: 512,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--units") out.units = Number(argv[++i]);
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--max-latency") out.maxLatencyMs = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
    else out.prompt = a;
  }
  if (!out.prompt) throw new Error('usage: agent.ts "prompt" [--units N] [--model m] [--max-latency ms] [--dry-run]');
  return out as typeof out & { prompt: string };
}

const log = (step: string, data?: unknown) =>
  console.log(`\n▸ ${step}${data === undefined ? "" : "\n" + JSON.stringify(data, null, 2)}`);

async function main() {
  const a = args(process.argv.slice(2));
  const cfg = loadConfig();
  const ledger = new Ledger(cfg);
  const api = new ComputePassClient(cfg, ledger);
  const need: Need = { units: a.units, model: a.model, maxLatencyMs: a.maxLatencyMs };

  log("1. Discover", { api: cfg.apiUrl, wallet: api.address ?? "(none: dry run only)" });
  const status = await api.status().catch((e) => ({ error: (e as Error).message }));
  const offers = await api.offers();
  log("   status", status);
  log("   offers", offers.map(({ raw: _r, ...o }) => o));

  log("2. Compare within budget", ledger.budgetStatus());
  const quotes = quote(offers, need, cfg, ledger.budgetStatus().remainingToday);
  for (const q of quotes)
    console.log(`   ${q.withinBudget ? "✓" : "✗"} ${q.offer.id}  ${q.offer.model}  ${q.cost} U  (${q.offer.pricePerKUnits.toFixed(6)} U/1k units)${q.reason ? "  " + q.reason : ""}`);

  let voucher = api.address ? usableVoucher(await api.vouchers(), offers, need) : undefined;
  if (voucher) {
    log("3. Reuse existing voucher (no payment needed)", { id: voucher.id, remaining: voucher.remainingUnits });
  } else {
    const best = quotes.find((q) => q.withinBudget);
    if (!best) throw new Error("no offer fits the need and the budget; stopping without paying");
    if (a.dryRun || !api.address) {
      log("3. Would buy (dry run)", { offerId: best.offer.id, cost: best.cost });
      return;
    }
    log("3. Pay via x402", { offerId: best.offer.id, price: best.offer.price });
    const bought = await api.buy(best.offer.id);
    log("   voucher issued", { voucher: bought.voucher.id, paid: bought.paid, settlement: bought.settlement });
    voucher = bought.voucher;
  }

  log("4. Redeem inference");
  const r = await api.redeem(voucher.id, a.prompt, Math.min(a.units, 4096));
  log("   result", r);

  log("5. Receipt", ledger.receipt(voucher.id));
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
});
