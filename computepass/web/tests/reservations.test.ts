/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures read loosely-typed JSON */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { B402ExactClientScheme } from "@bnb-chain/b402/client";
import { recoverEip3009Payer } from "@bnb-chain/b402";
import { U_TOKEN } from "../lib/catalog";
import { handleReservation } from "../lib/server/reservations";
import { decodeHeader, encodeHeader } from "../lib/wire";
import type { Deps } from "../lib/server/types";
import { createTestDb } from "./d1-sqlite";

const MERCHANT = "0x00000000000000000000000000000000000be402";
const BASE = "https://computepass.test";
const buyer = privateKeyToAccount(generatePrivateKey());

type Facilitator = {
  verifyCalls: number;
  settleCalls: number;
  verify: (body: any) => Promise<Response>;
  settle: (body: any) => Promise<Response>;
};

function setup() {
  const db = createTestDb();
  const facilitator: Facilitator = {
    verifyCalls: 0,
    settleCalls: 0,
    // Like a real facilitator: recover the EIP-3009 signer and compare with `from`.
    verify: async (body) => {
      const payer = await recoverEip3009Payer(body.paymentPayload);
      const ok = getAddress(payer) === getAddress(body.paymentPayload.payload.authorization.from);
      return Response.json({ isValid: ok, invalidReason: ok ? undefined : "bad_signature" });
    },
    settle: async (body) => Response.json({ success: true, transaction: "0x" + body.paymentPayload.payload.authorization.nonce.slice(2, 66), network: "eip155:97" }),
  };
  const deps: Deps = {
    db,
    env: { MERCHANT_ADDRESS: MERCHANT },
    now: () => Math.floor(Date.now() / 1000),
    fetch: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/verify")) {
        facilitator.verifyCalls++;
        return facilitator.verify(body);
      }
      if (url.endsWith("/settle")) {
        facilitator.settleCalls++;
        return facilitator.settle(body);
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch,
  };
  const sent: string[] = [];
  const server = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const header = request.headers.get("payment-signature");
    if (header) sent.push(header);
    return handleReservation(request, deps);
  }) as typeof fetch;
  // Same spend controls as app/page.tsx: only U, never more than the advertised price.
  const payments = new x402Client()
    .register("eip155:*", new B402ExactClientScheme({ account: buyer, methods: ["eip3009"] }))
    .setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: "eip155:97", asset: U_TOKEN, maxAmountPerPayment: "80000000000000000" }] });
  const paidFetch = wrapFetchWithPayment(server, payments);
  const buy = (offerId = "llama-70b-burst", who: string = buyer.address) =>
    paidFetch(`${BASE}/api/reservations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offerId, buyer: who }) });
  const resend = (header: string, offerId = "llama-70b-burst", who: string = buyer.address) =>
    handleReservation(
      new Request(`${BASE}/api/reservations`, {
        method: "POST",
        headers: { "content-type": "application/json", "payment-signature": header },
        body: JSON.stringify({ offerId, buyer: who }),
      }),
      deps,
    );
  return { db, deps, facilitator, sent, buy, resend };
}

const count = (db: ReturnType<typeof createTestDb>, table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("POST /api/reservations", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("answers 402 with x402 v2 requirements when unpaid", async () => {
    const res = await handleReservation(
      new Request(`${BASE}/api/reservations`, { method: "POST", body: JSON.stringify({ offerId: "llama-70b-burst", buyer: buyer.address }) }),
      ctx.deps,
    );
    assert.equal(res.status, 402);
    const required = decodeHeader<any>(res.headers.get("PAYMENT-REQUIRED")!);
    assert.equal(required.accepts[0].amount, "25000000000000000");
    assert.equal(required.accepts[0].payTo, getAddress(MERCHANT));
  });

  it("buys a voucher end to end with the official x402 + B402 client", async () => {
    const res = await ctx.buy();
    assert.equal(res.status, 201);
    const { voucher } = await res.json() as any;
    assert.equal(voucher.ownerAddress, buyer.address.toLowerCase());
    assert.equal(voucher.remainingUnits, 50_000);
    assert.ok(res.headers.get("PAYMENT-RESPONSE"));
    assert.equal(ctx.facilitator.settleCalls, 1);
  });

  it("is idempotent: resending the same payment returns the same voucher and never settles twice", async () => {
    const first = await (await ctx.buy()).json() as any;
    const again = await ctx.resend(ctx.sent[0]);
    assert.equal(again.status, 200);
    assert.equal((await again.json() as any).voucher.id, first.voucher.id);
    assert.equal(ctx.facilitator.settleCalls, 1);
    assert.equal(count(ctx.db, "vouchers"), 1);
  });

  it("lets only one of two concurrent submissions reach settlement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const settle = ctx.facilitator.settle;
    ctx.facilitator.settle = async (b) => {
      await gate;
      return settle(b);
    };
    const firstAttempt = ctx.buy();
    while (!ctx.sent.length) await new Promise((r) => setTimeout(r, 5));
    const duplicate = await ctx.resend(ctx.sent[0]);
    release();
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as any).error, "payment_in_progress");
    assert.equal((await firstAttempt).status, 201);
    assert.equal(ctx.facilitator.settleCalls, 1);
    assert.equal(count(ctx.db, "vouchers"), 1);
  });

  it("issues nothing when verification fails, and allows a clean retry", async () => {
    ctx.facilitator.verify = async () => Response.json({ isValid: false, invalidReason: "insufficient_funds" });
    const res = await ctx.buy();
    assert.equal(res.status, 402);
    assert.equal(count(ctx.db, "vouchers"), 0);
    ctx.facilitator.verify = async () => Response.json({ isValid: true });
    const retry = await ctx.resend(ctx.sent[0]);
    assert.equal(retry.status, 201);
  });

  it("keeps the payment pending when the settlement outcome is unknown", async () => {
    ctx.facilitator.settle = async () => {
      throw new Error("timeout");
    };
    const res = await ctx.buy();
    assert.equal(res.status, 502);
    assert.equal((await res.json() as any).error, "settlement_outcome_unknown");
    const retry = await ctx.resend(ctx.sent[0]);
    assert.equal(retry.status, 409);
    assert.equal(ctx.facilitator.settleCalls, 1);
    assert.equal(count(ctx.db, "vouchers"), 0);
    const row = ctx.db.raw.prepare("SELECT status FROM payments").get() as { status: string };
    assert.equal(row.status, "pending");
  });

  it("recovers a voucher when settlement was recorded but issuing crashed", async () => {
    await ctx.buy();
    ctx.db.raw.exec("DELETE FROM vouchers");
    const retry = await ctx.resend(ctx.sent[0]);
    assert.equal(retry.status, 200);
    assert.equal(count(ctx.db, "vouchers"), 1);
    assert.equal(ctx.facilitator.settleCalls, 1);
  });

  it("rejects an authorization that pays someone else or a different amount", async () => {
    await ctx.buy();
    const payload = decodeHeader<any>(ctx.sent[0]);
    const tamper = (mut: (p: any) => void) => {
      const copy = structuredClone(payload);
      copy.payload.authorization.nonce = "0x" + "c".repeat(64);
      mut(copy);
      return encodeHeader(copy);
    };
    const wrongTo = await ctx.resend(tamper((p) => (p.payload.authorization.to = buyer.address)));
    assert.equal(wrongTo.status, 400);
    const wrongValue = await ctx.resend(tamper((p) => (p.payload.authorization.value = "1")));
    assert.equal(wrongValue.status, 400);
    assert.equal(ctx.facilitator.settleCalls, 1);
  });

  it("rejects a payment whose payer is not the declared buyer", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const res = await ctx.buy("llama-70b-burst", other.address);
    assert.equal(res.status, 400);
    assert.equal((await res.json() as any).error, "payment_payer_mismatch");
    assert.equal(ctx.facilitator.verifyCalls, 0);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await handleReservation(new Request(`${BASE}/api/reservations`, { method: "POST", body: "{" }), ctx.deps);
    assert.equal(res.status, 400);
  });
});
