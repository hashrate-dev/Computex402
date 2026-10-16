import { getAddress, isAddress } from "viem";
import { jsonError } from "../wire";
import type { Deps } from "./types";

/** GET /api/vouchers?owner=0x… — status is derived, so expired or empty vouchers never read as active. */
export async function handleListVouchers(request: Request, deps: Deps): Promise<Response> {
  const owner = new URL(request.url).searchParams.get("owner") || "";
  if (!isAddress(owner)) return jsonError("wallet_invalid", 400);
  if (!deps.db) return jsonError("database_unavailable", 503);
  const now = deps.now();
  const result = await deps.db
    .prepare(
      `SELECT id, offer_id AS offerId, owner_address AS ownerAddress,
        total_units AS totalUnits, remaining_units AS remainingUnits,
        payment_tx AS paymentTx, contract_token_id AS contractTokenId,
        CASE WHEN status <> 'active' THEN status
             WHEN expires_at <= ? THEN 'expired'
             WHEN remaining_units <= 0 THEN 'spent'
             ELSE 'active' END AS status,
        issued_at AS issuedAt, expires_at AS expiresAt
       FROM vouchers WHERE owner_address = ? ORDER BY issued_at DESC LIMIT 50`,
    )
    .bind(now, getAddress(owner).toLowerCase())
    .all();
  return Response.json({ vouchers: result.results }, { headers: { "Cache-Control": "no-store" } });
}
