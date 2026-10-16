import { decodeFunctionResult, encodeFunctionData, getAddress, pad, toEventSelector, type Hex } from "viem";
import { U_TOKEN, getOffer } from "../catalog";
import { issueVoucher, type PaymentRow } from "./reservations";
import type { Deps, SqlDb, SqlStatement } from "./types";

export const DEFAULT_BSC_TESTNET_RPC = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
/** Far above the 120 s upstream timeout, so a live request is never swept. */
export const STALE_REDEMPTION_SECONDS = 15 * 60;
/** Facilitator timeout (300 s) plus margin before a pending payment is checked on-chain. */
export const STALE_PAYMENT_SECONDS = 10 * 60;
const BSC_BLOCK_SECONDS = 3;
const LOG_WINDOW_BLOCKS = 4_000n;

/**
 * Returns a reservation to the voucher and closes the redemption, atomically
 * and only if the redemption is still pending. Safe to run twice.
 */
export function releaseReservation(
  db: SqlDb,
  redemptionId: string,
  voucherId: string,
  units: number,
  status: "failed" | "expired",
): SqlStatement[] {
  return [
    db
      .prepare(
        `UPDATE vouchers SET remaining_units = remaining_units + ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM redemptions WHERE id = ? AND status = 'pending')`,
      )
      .bind(units, voucherId, redemptionId),
    db
      .prepare("UPDATE redemptions SET status = ?, reserved_units = 0 WHERE id = ? AND status = 'pending'")
      .bind(status, redemptionId),
  ];
}

/** Refunds reservations of redemptions left pending by a worker that died mid-inference. */
export async function sweepStaleRedemptions(deps: Deps): Promise<{ expired: number }> {
  const db = deps.db!;
  const cutoff = deps.now() - STALE_REDEMPTION_SECONDS;
  const { results } = await db
    .prepare(
      `SELECT id, voucher_id AS voucherId, reserved_units AS reservedUnits
       FROM redemptions WHERE status = 'pending' AND created_at < ? LIMIT 200`,
    )
    .bind(cutoff)
    .all<{ id: string; voucherId: string; reservedUnits: number }>();
  for (const row of results) {
    await db.batch(releaseReservation(db, row.id, row.voucherId, row.reservedUnits, "expired"));
  }
  return { expired: results.length };
}

const EIP3009_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
const AUTHORIZATION_USED = toEventSelector("AuthorizationUsed(address,bytes32)");

export async function rpc<T>(deps: Deps, method: string, params: unknown[]): Promise<T> {
  const url = deps.env.BSC_RPC_URL || DEFAULT_BSC_TESTNET_RPC;
  const response = await deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (!response.ok || body.error || body.result === undefined) {
    throw new Error(`rpc ${method}: ${body.error?.message ?? response.status}`);
  }
  return body.result;
}

/** True once the token has consumed this EIP-3009 authorization, i.e. the payment happened. */
export async function authorizationUsed(deps: Deps, payer: string, nonce: Hex): Promise<boolean> {
  const data = encodeFunctionData({ abi: EIP3009_ABI, functionName: "authorizationState", args: [getAddress(payer), nonce] });
  const result = await rpc<Hex>(deps, "eth_call", [{ to: U_TOKEN, data }, "latest"]);
  return decodeFunctionResult({ abi: EIP3009_ABI, functionName: "authorizationState", data: result });
}

/** Best effort: the tx that emitted AuthorizationUsed(payer, nonce), searched near the payment time. */
async function findSettlementTx(deps: Deps, payer: string, nonce: Hex, createdAt: number): Promise<string | null> {
  try {
    const latest = BigInt(await rpc<Hex>(deps, "eth_blockNumber", []));
    const blocksAgo = BigInt(Math.max(0, Math.ceil((deps.now() - createdAt) / BSC_BLOCK_SECONDS)));
    const center = latest > blocksAgo ? latest - blocksAgo : 0n;
    const fromBlock = center > LOG_WINDOW_BLOCKS / 4n ? center - LOG_WINDOW_BLOCKS / 4n : 0n;
    const toBlock = fromBlock + LOG_WINDOW_BLOCKS < latest ? fromBlock + LOG_WINDOW_BLOCKS : latest;
    const logs = await rpc<Array<{ transactionHash: string }>>(deps, "eth_getLogs", [
      {
        address: U_TOKEN,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        topics: [AUTHORIZATION_USED, pad(getAddress(payer).toLowerCase() as Hex), nonce],
      },
    ]);
    return logs[0]?.transactionHash ?? null;
  } catch {
    return null;
  }
}

export type ReconcileOutcome = { nonce: string; result: "settled" | "failed" | "still_pending" | "error"; detail?: string };

/**
 * Resolves payments stuck in `pending` (settlement outcome unknown) against
 * the chain: a consumed authorization means the buyer paid, so the voucher is
 * issued; an unconsumed one past its validBefore can never settle, so it is
 * marked failed and the buyer may pay again.
 */
export async function reconcilePendingPayments(deps: Deps): Promise<ReconcileOutcome[]> {
  const db = deps.db!;
  const now = deps.now();
  const { results } = await db
    .prepare(
      `SELECT nonce, voucher_id AS voucherId, offer_id AS offerId, payer, status, payment_tx AS paymentTx,
        created_at AS createdAt, updated_at AS updatedAt, valid_before AS validBefore
       FROM payments WHERE status = 'pending' AND updated_at < ? LIMIT 50`,
    )
    .bind(now - STALE_PAYMENT_SECONDS)
    .all<PaymentRow & { createdAt: number; validBefore: number | null }>();

  const outcomes: ReconcileOutcome[] = [];
  for (const row of results) {
    try {
      const offer = getOffer(row.offerId);
      if (!offer) throw new Error(`unknown offer ${row.offerId}`);
      if (await authorizationUsed(deps, row.payer, row.nonce as Hex)) {
        const tx = (await findSettlementTx(deps, row.payer, row.nonce as Hex, row.createdAt)) ?? `eip3009:${row.nonce}`;
        const settledAt = deps.now();
        const update = await db
          .prepare(
            "UPDATE payments SET status = 'settled', payment_tx = ?, error = 'reconciled_onchain', updated_at = ? WHERE nonce = ? AND status = 'pending'",
          )
          .bind(tx, settledAt, row.nonce)
          .run();
        if (update.meta.changes) await issueVoucher(db, { ...row, status: "settled", paymentTx: tx, updatedAt: settledAt }, offer);
        outcomes.push({ nonce: row.nonce, result: "settled", detail: tx });
      } else if (row.validBefore !== null && row.validBefore < now) {
        await db
          .prepare("UPDATE payments SET status = 'failed', error = 'authorization_expired_unused', updated_at = ? WHERE nonce = ? AND status = 'pending'")
          .bind(deps.now(), row.nonce)
          .run();
        outcomes.push({ nonce: row.nonce, result: "failed", detail: "authorization expired without being used" });
      } else {
        outcomes.push({ nonce: row.nonce, result: "still_pending" });
      }
    } catch (error) {
      outcomes.push({ nonce: row.nonce, result: "error", detail: (error as Error).message.slice(0, 200) });
    }
  }
  return outcomes;
}

export function sameSecret(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/**
 * POST /api/admin/maintenance with `Authorization: Bearer $ADMIN_TOKEN`.
 * Meant for a cron (every 5–10 minutes). Disabled when ADMIN_TOKEN is unset.
 */
export async function handleMaintenance(request: Request, deps: Deps): Promise<Response> {
  const token = deps.env.ADMIN_TOKEN;
  if (!token || token.length < 32) return Response.json({ error: "maintenance_disabled" }, { status: 404 });
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!sameSecret(given, token)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!deps.db) return Response.json({ error: "database_unavailable" }, { status: 503 });
  const redemptions = await sweepStaleRedemptions(deps);
  const payments = await reconcilePendingPayments(deps);
  return Response.json({ redemptions, payments }, { headers: { "Cache-Control": "no-store" } });
}
