import assert from "node:assert/strict";
import { it } from "node:test";
import { MIN_MARGIN, offers } from "../lib/catalog";

it("prices every pass above its worst-case provider cost", () => {
  for (const offer of offers) {
    const worstUsdPerToken = Math.max(offer.upstreamUsdPerMTok.prompt, offer.upstreamUsdPerMTok.completion) / 1e6;
    const worstCost = offer.units * worstUsdPerToken;
    const price = Number(BigInt(offer.priceAtomic)) / 10 ** offer.decimals;
    assert.ok(price >= worstCost * MIN_MARGIN, `${offer.id}: price ${price} U < ${MIN_MARGIN} x cost ${worstCost.toFixed(4)} USD`);
  }
});
