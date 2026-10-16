/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures read loosely-typed JSON */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { handleRedeem } from "../lib/server/redeem";
import { sweepStaleRedemptions } from "../lib/server/maintenance";
import { CHAIN_ID, redemptionMessage } from "../lib/protocol";
import type { Deps } from "../lib/server/types";
import { createTestDb } from "./d1-sqlite";

const NOW = 1_800_000_000;
const HOST = "computepass.test";
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const LLAMA_VOUCHER = "11111111-1111-4111-8111-111111111111";
const R1_VOUCHER = "22222222-2222-4222-8222-222222222222";

type Upstream = { calls: Array<{ model: string; max_tokens: number }>; reply: (body: any) => Response | Promise<Response> };

function setup() {
  const db = createTestDb();
  const seed = db.raw.prepare(
    `INSERT INTO vouchers (id, offer_id, owner_address, total_units, remaining_units, payment_nonce, payment_tx, status, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  );
  seed.run(LLAMA_VOUCHER, "llama-70b-burst", owner.address.toLowerCase(), 50_000, 50_000, "0x" + "a".repeat(64), "0xtx1", NOW - 10, NOW + 86_400);
  seed.run(R1_VOUCHER, "deepseek-r1-flex", owner.address.toLowerCase(), 100_000, 100_000, "0x" + "b".repeat(64), "0xtx2", NOW - 10, NOW + 86_400);
  const upstream: Upstream = {
    calls: [],
    reply: (body) =>
      Response.json({
        model: body.model,
        choices: [{ message: { content: "hola" } }],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      }),
  };
  const deps: Deps = {
    db,
    env: { INFERENCE_API_KEY: "sk-test", INFERENCE_API_URL: "https://llm.test/v1" },
    now: () => NOW,
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      upstream.calls.push(body);
      return upstream.reply(body);
    }) as typeof fetch,
  };
  return { db, deps, upstream };
}

async function signedBody(opts: Partial<{ voucherId: string; offerId: string; prompt: string; maxUnits: number; expiresAt: number; domain: string; signer: typeof owner; address: string; nonce: string }> = {}) {
  const voucherId = opts.voucherId ?? LLAMA_VOUCHER;
  const offerId = opts.offerId ?? "llama-70b-burst";
  const prompt = opts.prompt ?? "Explicá x402";
  const maxUnits = opts.maxUnits ?? 256;
  const nonce = opts.nonce ?? "0x" + randomBytes(32).toString("hex");
  const expiresAt = opts.expiresAt ?? NOW + 300;
  const signer = opts.signer ?? owner;
  const promptSha256 = createHash("sha256").update(prompt).digest("hex");
  const signature = await signer.signMessage({
    message: redemptionMessage({ domain: opts.domain ?? HOST, chainId: CHAIN_ID, voucherId, offerId, promptSha256, maxUnits, nonce, expiresAt }),
  });
  return { voucherId, offerId, prompt, maxUnits, nonce, expiresAt, address: opts.address ?? signer.address, signature };
}

const post = (body: unknown) =>
  new Request(`https://${HOST}/api/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

const remaining = (db: ReturnType<typeof createTestDb>, id: string) =>
  (db.raw.prepare("SELECT remaining_units AS r FROM vouchers WHERE id = ?").get(id) as { r: number }).r;

describe("POST /api/redeem", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("bills prompt + completion tokens and refunds the rest of the reservation", async () => {
    const res = await handleRedeem(post(await signedBody()), ctx.deps);
    assert.equal(res.status, 200);
    const json = await res.json() as any;
    assert.equal(json.usedUnits, 50);
    assert.equal(json.remainingUnits, 50_000 - 50);
    assert.deepEqual(json.usage, { promptTokens: 20, completionTokens: 30, billedFromProvider: true });
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 49_950);
  });

  it("rejects a replayed signature without debiting again", async () => {
    const body = await signedBody();
    assert.equal((await handleRedeem(post(body), ctx.deps)).status, 200);
    const replay = await handleRedeem(post(body), ctx.deps);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json() as any).error, "nonce_already_used");
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 49_950);
    assert.equal(ctx.upstream.calls.length, 1);
  });

  it("rejects concurrent submissions of the same signature", async () => {
    const body = await signedBody();
    const results = await Promise.all([handleRedeem(post(body), ctx.deps), handleRedeem(post(body), ctx.deps)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 49_950);
  });

  it("rejects expired signatures and overly long TTLs", async () => {
    const expired = await handleRedeem(post(await signedBody({ expiresAt: NOW })), ctx.deps);
    assert.equal((await expired.json() as any).error, "signature_expired");
    const longTtl = await handleRedeem(post(await signedBody({ expiresAt: NOW + 3600 })), ctx.deps);
    assert.equal((await longTtl.json() as any).error, "signature_ttl_too_long");
  });

  it("rejects a signature made for another domain", async () => {
    const res = await handleRedeem(post(await signedBody({ domain: "evil.example" })), ctx.deps);
    assert.equal(res.status, 401);
    assert.equal((await res.json() as any).error, "wallet_signature_invalid");
  });

  it("rejects a tampered prompt or cap", async () => {
    const body = await signedBody();
    assert.equal((await handleRedeem(post({ ...body, prompt: "otro prompt" }), ctx.deps)).status, 401);
    assert.equal((await handleRedeem(post({ ...body, maxUnits: 4000 }), ctx.deps)).status, 401);
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 50_000);
  });

  it("does not let a non-owner spend the voucher", async () => {
    const res = await handleRedeem(post(await signedBody({ signer: stranger })), ctx.deps);
    assert.equal(res.status, 404);
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 50_000);
  });

  it("serves each offer with its own provider model", async () => {
    await handleRedeem(post(await signedBody()), ctx.deps);
    await handleRedeem(post(await signedBody({ voucherId: R1_VOUCHER, offerId: "deepseek-r1-flex" })), ctx.deps);
    assert.deepEqual(ctx.upstream.calls.map((c) => c.model), ["meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-r1"]);
  });

  it("refuses to serve a voucher under a different offer", async () => {
    const res = await handleRedeem(post(await signedBody({ voucherId: LLAMA_VOUCHER, offerId: "deepseek-r1-flex" })), ctx.deps);
    assert.equal(res.status, 409);
    assert.equal((await res.json() as any).error, "offer_mismatch");
    assert.equal(ctx.upstream.calls.length, 0);
  });

  it("sizes max_tokens so prompt + completion fits the signed cap", async () => {
    await handleRedeem(post(await signedBody({ prompt: "x".repeat(300), maxUnits: 200 })), ctx.deps);
    // estimate = ceil(300/3)+16 = 116 -> completion budget 84
    assert.equal(ctx.upstream.calls[0].max_tokens, 84);
    const tooSmall = await handleRedeem(post(await signedBody({ prompt: "x".repeat(3000), maxUnits: 200 })), ctx.deps);
    assert.equal((await tooSmall.json() as any).error, "max_units_below_prompt");
  });

  it("never bills more than the signed cap", async () => {
    ctx.upstream.reply = () => Response.json({ choices: [{ message: { content: "…" } }], usage: { prompt_tokens: 900, completion_tokens: 900 } });
    const json = await (await handleRedeem(post(await signedBody({ maxUnits: 256 })), ctx.deps)).json() as any;
    assert.equal(json.usedUnits, 256);
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 50_000 - 256);
  });

  it("bills the full reservation when the provider reports no usage", async () => {
    ctx.upstream.reply = () => Response.json({ choices: [{ message: { content: "…" } }] });
    const json = await (await handleRedeem(post(await signedBody({ maxUnits: 300 })), ctx.deps)).json() as any;
    assert.equal(json.usedUnits, 300);
    assert.equal(json.usage.billedFromProvider, false);
  });

  it("returns the whole reservation when the provider fails", async () => {
    ctx.upstream.reply = () => new Response("boom", { status: 500 });
    const res = await handleRedeem(post(await signedBody()), ctx.deps);
    assert.equal(res.status, 502);
    assert.equal((await res.json() as any).detail, "upstream_500");
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 50_000);
    const row = ctx.db.raw.prepare("SELECT status, units FROM redemptions").get() as { status: string; units: number };
    assert.deepEqual({ ...row }, { status: "failed", units: 0 });
  });

  it("lets only one of two redemptions through when capacity covers one", async () => {
    ctx.db.raw.prepare("UPDATE vouchers SET remaining_units = 300 WHERE id = ?").run(LLAMA_VOUCHER);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = ctx.upstream.reply;
    ctx.upstream.reply = async (b) => {
      await gate;
      return original(b);
    };
    const a = handleRedeem(post(await signedBody({ maxUnits: 200 })), ctx.deps);
    const b = handleRedeem(post(await signedBody({ maxUnits: 200 })), ctx.deps);
    setTimeout(release, 20);
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 300 - 50);
  });

  it("never refunds twice when a sweep races a slow inference", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = ctx.upstream.reply;
    ctx.upstream.reply = async (b) => {
      await gate;
      return original(b);
    };
    const inflight = handleRedeem(post(await signedBody({ maxUnits: 300 })), ctx.deps);
    while (!ctx.upstream.calls.length) await new Promise((r) => setTimeout(r, 2));
    assert.deepEqual(await sweepStaleRedemptions({ ...ctx.deps, now: () => NOW + 20 * 60 }), { expired: 1 });
    release();
    await inflight;
    // The sweep returned the 300 reserved units; the late completion must not refund again.
    assert.equal(remaining(ctx.db, LLAMA_VOUCHER), 50_000);
  });

  it("rejects malformed bodies with 400 instead of crashing", async () => {
    assert.equal((await handleRedeem(post("not json"), ctx.deps)).status, 400);
    assert.equal((await handleRedeem(post({ voucherId: LLAMA_VOUCHER }), ctx.deps)).status, 400);
  });

  it("does not leak provider error bodies", async () => {
    ctx.upstream.reply = () => {
      throw new Error("connect ECONNREFUSED with key sk-test");
    };
    const json = await (await handleRedeem(post(await signedBody()), ctx.deps)).json() as any;
    assert.ok(!JSON.stringify(json).includes("sk-test"));
  });
});
