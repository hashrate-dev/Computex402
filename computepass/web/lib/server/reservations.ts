import { getAddress, isAddress } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { DEFAULT_FACILITATOR, FACILITATOR_SIGNER, NETWORK, U_TOKEN, getOffer, type Offer } from "../catalog";
import { decodeHeader, encodeHeader, jsonError, postJson, readJsonObject } from "../wire";
import type { Deps, SqlDb } from "./types";

const MAX_TIMEOUT_SECONDS = 300;
const VERIFY_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 60_000;
/** An authorization must stay valid at least this long for settlement to land. */
const MIN_VALIDITY_LEFT_SECONDS = 30;

function sameRequirements(left: PaymentRequirements, right: PaymentRequirements) {
  return (
    left.scheme === right.scheme &&
    left.network === right.network &&
    left.asset.toLowerCase() === right.asset.toLowerCase() &&
    left.amount === right.amount &&
    left.payTo.toLowerCase() === right.payTo.toLowerCase() &&
    left.maxTimeoutSeconds === right.maxTimeoutSeconds &&
    left.extra?.assetTransferMethod === right.extra?.assetTransferMethod &&
    left.extra?.name === right.extra?.name &&
    left.extra?.version === right.extra?.version &&
    String(left.extra?.signerAddress).toLowerCase() === String(right.extra?.signerAddress).toLowerCase()
  );
}

export type PaymentRow = {
  nonce: string;
  voucherId: string;
  offerId: string;
  payer: string;
  status: "pending" | "settled" | "failed";
  paymentTx: string | null;
  updatedAt: number;
};

const toBigInt = (value: unknown): bigint | null => {
  try {
    return typeof value === "string" || typeof value === "number" ? BigInt(value) : null;
  } catch {
    return null;
  }
};

/** Inserts the voucher for a settled payment. Idempotent: safe to call again on retry. */
export async function issueVoucher(db: SqlDb, payment: PaymentRow, offer: Offer) {
  const issuedAt = payment.updatedAt;
  const expiresAt = issuedAt + offer.expiresInDays * 86_400;
  await db
    .prepare(
      `INSERT INTO vouchers
        (id, offer_id, owner_address, total_units, remaining_units, payment_nonce,
         payment_tx, contract_token_id, status, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(payment.voucherId, offer.id, payment.payer, offer.units, offer.units, payment.nonce, payment.paymentTx, issuedAt, expiresAt)
    .run();
  return db
    .prepare(
      `SELECT id, offer_id AS offerId, owner_address AS ownerAddress, total_units AS totalUnits,
        remaining_units AS remainingUnits, payment_tx AS paymentTx, contract_token_id AS contractTokenId,
        status, issued_at AS issuedAt, expires_at AS expiresAt
       FROM vouchers WHERE id = ?`,
    )
    .bind(payment.voucherId)
    .first();
}

function voucherResponse(voucher: unknown, payment: PaymentRow, status: number) {
  const paymentResponse = { success: true, transaction: payment.paymentTx, network: NETWORK, payer: payment.payer };
  return Response.json(
    { voucher },
    {
      status,
      headers: {
        "PAYMENT-RESPONSE": encodeHeader(paymentResponse),
        "Access-Control-Expose-Headers": "PAYMENT-RESPONSE",
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * POST /api/reservations: x402 purchase of a voucher.
 *
 * Money rules:
 * - The EIP-3009 nonce is claimed in `payments` before calling the
 *   facilitator, so concurrent submissions of the same authorization cannot
 *   both reach settlement or both mint a voucher.
 * - A voucher is only issued after a successful settlement, and issuing is
 *   idempotent: if the worker dies between settlement and issuing, resending
 *   the same PAYMENT-SIGNATURE issues the voucher instead of charging again.
 * - When the settlement outcome is unknown (timeout, bad response) the
 *   payment stays `pending` and is never auto-retried; reconcilePendingPayments
 *   (lib/server/maintenance.ts) resolves it against the chain.
 */
export async function handleReservation(request: Request, deps: Deps): Promise<Response> {
  const { db, env } = deps;
  if (!db) return jsonError("database_unavailable", 503);
  if (!env.MERCHANT_ADDRESS || !isAddress(env.MERCHANT_ADDRESS)) {
    return jsonError("merchant_not_configured", 503, "Falta configurar la dirección receptora de testnet.");
  }

  const body = await readJsonObject(request);
  if (!body) return jsonError("request_invalid", 400, "El cuerpo debe ser un objeto JSON.");
  const offer = getOffer(typeof body.offerId === "string" ? body.offerId : "");
  if (!offer) return jsonError("offer_not_found", 404);
  const buyerInput = typeof body.buyer === "string" ? body.buyer : "";
  if (!isAddress(buyerInput)) return jsonError("wallet_invalid", 400);
  const buyer = getAddress(buyerInput).toLowerCase();
  const payTo = getAddress(env.MERCHANT_ADDRESS);

  const requirement: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: U_TOKEN,
    amount: offer.priceAtomic,
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { assetTransferMethod: "eip3009", name: "United Stables", version: "1", signerAddress: FACILITATOR_SIGNER },
  };
  const resource = {
    url: new URL("/api/reservations", request.url).toString(),
    description: `ComputePass: ${offer.units.toLocaleString("en-US")} unidades para ${offer.model}`,
    mimeType: "application/json",
    serviceName: "ComputePass 402",
  };
  const paymentRequired = { x402Version: 2, resource, accepts: [requirement] };

  const paymentHeader = request.headers.get("payment-signature");
  if (!paymentHeader) {
    return Response.json(paymentRequired, {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodeHeader(paymentRequired),
        "Cache-Control": "no-store",
        "Access-Control-Expose-Headers": "PAYMENT-REQUIRED",
      },
    });
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = decodeHeader<PaymentPayload>(paymentHeader);
  } catch {
    return jsonError("payment_signature_invalid", 400);
  }
  if (paymentPayload?.x402Version !== 2 || !paymentPayload.accepted || !sameRequirements(paymentPayload.accepted, requirement)) {
    return jsonError("payment_requirements_mismatch", 400);
  }

  // Defense in depth: the signed authorization itself must pay us the exact
  // amount from the declared buyer, not only the `accepted` echo.
  const authorization = (paymentPayload.payload as Record<string, unknown> | undefined)?.authorization as
    | Record<string, unknown>
    | undefined;
  const from = typeof authorization?.from === "string" ? authorization.from : "";
  const to = typeof authorization?.to === "string" ? authorization.to : "";
  const nonceRaw = typeof authorization?.nonce === "string" ? authorization.nonce : "";
  const value = toBigInt(authorization?.value);
  const validAfter = toBigInt(authorization?.validAfter);
  const validBefore = toBigInt(authorization?.validBefore);
  if (!isAddress(from) || getAddress(from).toLowerCase() !== buyer || !/^0x[0-9a-fA-F]{64}$/.test(nonceRaw)) {
    return jsonError("payment_payer_mismatch", 400);
  }
  if (!isAddress(to) || getAddress(to) !== payTo || value !== BigInt(offer.priceAtomic)) {
    return jsonError("payment_requirements_mismatch", 400, "La autorización no paga el monto exacto al receptor.");
  }
  const now = deps.now();
  if (validAfter === null || validBefore === null || validAfter > BigInt(now) || validBefore < BigInt(now + MIN_VALIDITY_LEFT_SECONDS)) {
    return jsonError("payment_authorization_expired", 400, "La autorización no está vigente.");
  }
  const nonce = nonceRaw.toLowerCase();

  // 1. Claim the nonce.
  const voucherId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const claim = await db
    .prepare(
      `INSERT INTO payments (nonce, voucher_id, offer_id, payer, amount_atomic, status, payment_tx, error, created_at, updated_at, valid_before)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
       ON CONFLICT(nonce) DO NOTHING`,
    )
    .bind(nonce, voucherId, offer.id, buyer, offer.priceAtomic, now, now, Number(validBefore))
    .run();

  if (!claim.meta.changes) {
    const existing = await db
      .prepare(
        `SELECT nonce, voucher_id AS voucherId, offer_id AS offerId, payer, status, payment_tx AS paymentTx,
          updated_at AS updatedAt FROM payments WHERE nonce = ?`,
      )
      .bind(nonce)
      .first<PaymentRow>();
    if (!existing || existing.payer !== buyer || existing.offerId !== offer.id) {
      return jsonError("payment_nonce_conflict", 409);
    }
    if (existing.status === "settled") {
      return voucherResponse(await issueVoucher(db, existing, offer), existing, 200);
    }
    if (existing.status === "pending") {
      return jsonError("payment_in_progress", 409, "Este pago ya se está procesando o espera conciliación.");
    }
    // A failed attempt (rejected by the facilitator) may be retried with the same authorization.
    const reclaim = await db
      .prepare("UPDATE payments SET status = 'pending', error = NULL, updated_at = ? WHERE nonce = ? AND status = 'failed'")
      .bind(now, nonce)
      .run();
    if (!reclaim.meta.changes) return jsonError("payment_in_progress", 409);
  }

  const claimed = await db
    .prepare(
      `SELECT nonce, voucher_id AS voucherId, offer_id AS offerId, payer, status, payment_tx AS paymentTx,
        updated_at AS updatedAt FROM payments WHERE nonce = ?`,
    )
    .bind(nonce)
    .first<PaymentRow>();
  if (!claimed) return jsonError("payment_state_lost", 500);

  const markFailed = (reason: string) =>
    db.prepare("UPDATE payments SET status = 'failed', error = ?, updated_at = ? WHERE nonce = ?").bind(reason.slice(0, 300), deps.now(), nonce).run();

  // 2. Verify. Any failure here is safe: no funds have moved.
  const facilitator = (env.FACILITATOR_URL || DEFAULT_FACILITATOR).replace(/\/+$/, "");
  const facilitatorBody = { x402Version: 2, paymentPayload, paymentRequirements: requirement };
  try {
    const verification = await postJson<{ isValid?: boolean; invalidReason?: string; invalidMessage?: string }>(
      deps.fetch,
      `${facilitator}/verify`,
      facilitatorBody,
      VERIFY_TIMEOUT_MS,
    );
    if (!verification.ok || !verification.json?.isValid) {
      const reason = verification.json?.invalidMessage || verification.json?.invalidReason || "El facilitador rechazó la autorización.";
      await markFailed(`verify: ${reason}`);
      return jsonError("payment_verification_failed", 402, reason);
    }
  } catch (error) {
    await markFailed(`verify_unreachable: ${(error as Error).message}`);
    return jsonError("facilitator_unavailable", 502, "No se pudo verificar el pago; no se cobró nada.");
  }

  // 3. Settle. From here a network error means the outcome is unknown.
  let settlement: { success?: boolean; transaction?: string; errorReason?: string; errorMessage?: string };
  try {
    const settled = await postJson<typeof settlement>(deps.fetch, `${facilitator}/settle`, facilitatorBody, SETTLE_TIMEOUT_MS);
    settlement = settled.json ?? {};
    if (!settled.ok && settlement.success === undefined) settlement.success = false;
  } catch (error) {
    await db
      .prepare("UPDATE payments SET error = ?, updated_at = ? WHERE nonce = ?")
      .bind(`settlement_outcome_unknown: ${(error as Error).message}`.slice(0, 300), deps.now(), nonce)
      .run();
    return jsonError(
      "settlement_outcome_unknown",
      502,
      "No sabemos si el pago se liquidó. No firmes otro pago: el estado se concilia con la cadena.",
    );
  }
  if (!settlement.success || !settlement.transaction) {
    await markFailed(`settle: ${settlement.errorMessage || settlement.errorReason || "unknown"}`);
    return jsonError("payment_settlement_failed", 502, settlement.errorMessage || settlement.errorReason || "No se pudo liquidar el pago.");
  }

  // 4. Record settlement, then issue the voucher (idempotent).
  const settledAt = deps.now();
  await db
    .prepare("UPDATE payments SET status = 'settled', payment_tx = ?, error = NULL, updated_at = ? WHERE nonce = ?")
    .bind(settlement.transaction, settledAt, nonce)
    .run();
  const payment: PaymentRow = { ...claimed, status: "settled", paymentTx: settlement.transaction, updatedAt: settledAt };
  return voucherResponse(await issueVoucher(db, payment, offer), payment, 201);
}
