import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeAbiParameters } from "viem";
import { handleMaintenance, reconcilePendingPayments, sweepStaleRedemptions } from "../lib/server/maintenance";
import type { Deps } from "../lib/server/types";
import { createTestDb } from "./d1-sqlite";

const T0 = 1_800_000_000;
const PAYER = "0x1111111111111111111111111111111111111111";
const VOUCHER = "33333333-3333-4333-8333-333333333333";

function setup(rpcAnswer: { used: boolean } = { used: false }) {
  const db = createTestDb();
  let now = T0;
  const rpcCalls: string[] = [];
  const deps: Deps = {
    db,
    env: { ADMIN_TOKEN: "x".repeat(40) },
    now: () => now,
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      rpcCalls.push(body.method);
      if (body.method === "eth_call") {
        decodeFunctionData({
          abi: [{ type: "function", name: "authorizationState", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" }],
          data: body.params[0].data,
        });
        return Response.json({ jsonrpc: "2.0", id: 1, result: encodeAbiParameters([{ type: "bool" }], [rpcAnswer.used]) });
      }
      if (body.method === "eth_blockNumber") return Response.json({ jsonrpc: "2.0", id: 1, result: "0x100000" });
      if (body.method === "eth_getLogs") return Response.json({ jsonrpc: "2.0", id: 1, result: [{ transactionHash: "0x" + "ab".repeat(32) }] });
      throw new Error(body.method);
    }) as typeof fetch,
  };
  return { db, deps, rpcCalls, advance: (s: number) => (now += s) };
}

const remaining = (db: ReturnType<typeof createTestDb>) =>
  (db.raw.prepare("SELECT remaining_units AS r FROM vouchers WHERE id = ?").get(VOUCHER) as { r: number }).r;

describe("maintenance", () => {
  it("returns reservations of stale pending redemptions exactly once", async () => {
    const { db, deps, advance } = setup();
    db.raw
      .prepare(
        `INSERT INTO vouchers (id, offer_id, owner_address, total_units, remaining_units, payment_nonce, payment_tx, status, issued_at, expires_at)
         VALUES (?, 'llama-70b-burst', ?, 1000, 700, 'n', 't', 'active', ?, ?)`,
      )
      .run(VOUCHER, PAYER, T0, T0 + 86_400);
    db.raw
      .prepare(
        `INSERT INTO redemptions (id, voucher_id, nonce, units, reserved_units, prompt_hash, model, status, created_at)
         VALUES ('r1', ?, '0x01', 0, 300, 'h', 'm', 'pending', ?)`,
      )
      .run(VOUCHER, T0);
    assert.deepEqual(await sweepStaleRedemptions(deps), { expired: 0 }, "fresh rows are left alone");
    advance(16 * 60);
    assert.deepEqual(await sweepStaleRedemptions(deps), { expired: 1 });
    assert.equal(remaining(db), 1000);
    await sweepStaleRedemptions(deps);
    assert.equal(remaining(db), 1000);
    const row = db.raw.prepare("SELECT status, reserved_units AS r FROM redemptions WHERE id = 'r1'").get() as { status: string; r: number };
    assert.deepEqual({ ...row }, { status: "expired", r: 0 });
  });

  const insertPending = (db: ReturnType<typeof createTestDb>, validBefore: number | null) =>
    db.raw
      .prepare(
        `INSERT INTO payments (nonce, voucher_id, offer_id, payer, amount_atomic, status, created_at, updated_at, valid_before)
         VALUES (?, ?, 'llama-70b-burst', ?, '25000000000000000', 'pending', ?, ?, ?)`,
      )
      .run("0x" + "cd".repeat(32), VOUCHER, PAYER, T0, T0, validBefore);

  it("issues the voucher when the chain shows the authorization was used", async () => {
    const { db, deps, advance } = setup({ used: true });
    insertPending(db, T0 + 300);
    advance(11 * 60);
    const [outcome] = await reconcilePendingPayments(deps);
    assert.equal(outcome.result, "settled");
    assert.equal(outcome.detail, "0x" + "ab".repeat(32));
    assert.equal(remaining(db), 50_000);
    const payment = db.raw.prepare("SELECT status FROM payments").get() as { status: string };
    assert.equal(payment.status, "settled");
  });

  it("fails a payment whose authorization expired unused, and leaves live ones pending", async () => {
    const { db, deps, advance } = setup({ used: false });
    insertPending(db, T0 + 3600);
    advance(11 * 60);
    assert.equal((await reconcilePendingPayments(deps))[0].result, "still_pending");
    advance(3600);
    assert.equal((await reconcilePendingPayments(deps))[0].result, "failed");
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM vouchers").get() as { n: number }).n, 0);
  });

  it("guards the admin endpoint with a bearer token", async () => {
    const { deps } = setup();
    const call = (auth?: string) =>
      handleMaintenance(new Request("https://x.test/api/admin/maintenance", { method: "POST", headers: auth ? { authorization: auth } : {} }), deps);
    assert.equal((await call()).status, 401);
    assert.equal((await call("Bearer wrong")).status, 401);
    assert.equal((await call(`Bearer ${"x".repeat(40)}`)).status, 200);
    assert.equal((await handleMaintenance(new Request("https://x.test/"), { ...deps, env: {} })).status, 404);
  });
});
