import { getAddress, isAddress, verifyMessage } from "viem";
import { DEFAULT_INFERENCE_API_URL, getOffer, upstreamModelFor } from "../catalog";
import {
  CHAIN_ID,
  MAX_COMPLETION_TOKENS,
  MAX_PROMPT_CHARS,
  MAX_REDEMPTION_UNITS,
  NONCE_PATTERN,
  REDEMPTION_MAX_TTL_SECONDS,
  UUID_PATTERN,
  estimatePromptTokens,
  redemptionMessage,
} from "../protocol";
import { jsonError, postJson, readJsonObject } from "../wire";
import type { Deps } from "./types";

const UPSTREAM_TIMEOUT_MS = 120_000;

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ChatCompletion = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
};

/**
 * POST /api/redeem
 *
 * Money rules:
 * - The nonce is claimed (unique index) before any capacity moves, so a
 *   signature can be used once even under concurrent requests.
 * - The signed `maxUnits` is reserved up front and is a hard cap: the user is
 *   never charged more than they signed for.
 * - Billed units = provider-reported prompt + completion tokens (capped at
 *   maxUnits). If the provider omits usage, the full reservation is billed.
 * - On provider failure the whole reservation is returned.
 */
export async function handleRedeem(request: Request, deps: Deps): Promise<Response> {
  const { db, env } = deps;
  if (!db) return jsonError("database_unavailable", 503);
  if (!env.INFERENCE_API_KEY) {
    return jsonError("inference_not_configured", 503, "Falta conectar un proveedor de inferencia compatible con OpenAI.");
  }

  const body = await readJsonObject(request);
  if (!body) return jsonError("request_invalid", 400, "El cuerpo debe ser un objeto JSON.");

  const voucherId = typeof body.voucherId === "string" ? body.voucherId.toLowerCase() : "";
  const offerId = typeof body.offerId === "string" ? body.offerId : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const maxUnits = body.maxUnits;
  const nonce = typeof body.nonce === "string" ? body.nonce.toLowerCase() : "";
  const expiresAt = body.expiresAt;
  const address = typeof body.address === "string" ? body.address : "";
  const signature = typeof body.signature === "string" ? body.signature : "";

  if (!UUID_PATTERN.test(voucherId) || !offerId) return jsonError("request_invalid", 400, "voucherId y offerId son obligatorios.");
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) {
    return jsonError("request_invalid", 400, `El prompt debe tener entre 1 y ${MAX_PROMPT_CHARS} caracteres.`);
  }
  if (typeof maxUnits !== "number" || !Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > MAX_REDEMPTION_UNITS) {
    return jsonError("request_invalid", 400, `maxUnits debe ser un entero entre 1 y ${MAX_REDEMPTION_UNITS}.`);
  }
  if (!NONCE_PATTERN.test(nonce)) return jsonError("request_invalid", 400, "nonce debe ser 32 bytes en hex (0x…).");
  if (typeof expiresAt !== "number" || !Number.isInteger(expiresAt)) return jsonError("request_invalid", 400, "expiresAt debe ser un timestamp Unix.");
  if (!isAddress(address) || !/^0x[0-9a-fA-F]+$/.test(signature)) return jsonError("wallet_signature_required", 401);

  const now = deps.now();
  if (expiresAt <= now) return jsonError("signature_expired", 401);
  if (expiresAt > now + REDEMPTION_MAX_TTL_SECONDS) {
    return jsonError("signature_ttl_too_long", 401, `La firma puede valer como máximo ${REDEMPTION_MAX_TTL_SECONDS} segundos.`);
  }

  const offer = getOffer(offerId);
  if (!offer) return jsonError("offer_not_found", 404);

  const promptBudget = estimatePromptTokens(prompt);
  const completionTokens = Math.min(MAX_COMPLETION_TOKENS, maxUnits - promptBudget);
  if (completionTokens < 1) {
    return jsonError("max_units_below_prompt", 400, `Este prompt necesita maxUnits de al menos ${promptBudget + 1}.`);
  }

  const promptSha256 = await sha256Hex(prompt);
  const domain = env.PUBLIC_HOST || new URL(request.url).host;
  const message = redemptionMessage({ domain, chainId: CHAIN_ID, voucherId, offerId, promptSha256, maxUnits, nonce, expiresAt });
  let validSignature = false;
  try {
    validSignature = await verifyMessage({ address: getAddress(address), message, signature: signature as `0x${string}` });
  } catch {
    validSignature = false;
  }
  if (!validSignature) return jsonError("wallet_signature_invalid", 401);

  const owner = getAddress(address).toLowerCase();
  const voucher = await db
    .prepare(
      `SELECT id, offer_id AS offerId, owner_address AS ownerAddress, remaining_units AS remainingUnits,
        status, expires_at AS expiresAt FROM vouchers WHERE id = ? LIMIT 1`,
    )
    .bind(voucherId)
    .first<{ id: string; offerId: string; ownerAddress: string; remainingUnits: number; status: string; expiresAt: number }>();
  if (!voucher || voucher.ownerAddress !== owner) return jsonError("voucher_not_found", 404);
  if (voucher.offerId !== offer.id) return jsonError("offer_mismatch", 409, "El voucher pertenece a otra oferta.");
  if (voucher.status !== "active" || voucher.expiresAt <= now) return jsonError("voucher_inactive", 409);
  if (voucher.remainingUnits < maxUnits) return jsonError("insufficient_capacity", 409);

  let model: string;
  try {
    model = upstreamModelFor(offer, env.INFERENCE_MODEL_MAP);
  } catch (error) {
    return jsonError("inference_not_configured", 503, (error as Error).message);
  }

  // 1. Claim the nonce. This is the replay guard; it happens before money moves.
  const redemptionId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const claim = await db
    .prepare(
      `INSERT INTO redemptions
        (id, voucher_id, nonce, units, reserved_units, prompt_tokens, completion_tokens, prompt_hash, model, status, created_at)
       VALUES (?, ?, ?, 0, ?, 0, 0, ?, ?, 'pending', ?)
       ON CONFLICT(nonce) DO NOTHING`,
    )
    .bind(redemptionId, voucherId, nonce, maxUnits, promptSha256, model, now)
    .run();
  if (!claim.meta.changes) return jsonError("nonce_already_used", 409, "Esta firma ya se usó. Firmá una nueva solicitud.");

  // 2. Reserve the signed cap, conditionally, in one statement.
  const reserve = await db
    .prepare(
      `UPDATE vouchers SET remaining_units = remaining_units - ?
       WHERE id = ? AND owner_address = ? AND status = 'active' AND expires_at > ? AND remaining_units >= ?`,
    )
    .bind(maxUnits, voucherId, owner, now, maxUnits)
    .run();
  if (!reserve.meta.changes) {
    await db.prepare("UPDATE redemptions SET status = 'rejected', reserved_units = 0 WHERE id = ?").bind(redemptionId).run();
    return jsonError("insufficient_capacity", 409, "Otra redención consumió la capacidad primero.");
  }

  // 3. Serve the inference.
  let result: ChatCompletion;
  try {
    const base = (env.INFERENCE_API_URL || DEFAULT_INFERENCE_API_URL).replace(/\/+$/, "");
    const upstream = await postJson<ChatCompletion>(
      deps.fetch,
      `${base}/chat/completions`,
      { model, messages: [{ role: "user", content: prompt }], max_tokens: completionTokens, stream: false },
      UPSTREAM_TIMEOUT_MS,
      { authorization: `Bearer ${env.INFERENCE_API_KEY}` },
    );
    if (!upstream.ok) throw new Error(`upstream_${upstream.status}`);
    result = upstream.json ?? {};
  } catch (error) {
    await db.batch([
      db.prepare("UPDATE vouchers SET remaining_units = remaining_units + ? WHERE id = ?").bind(maxUnits, voucherId),
      db.prepare("UPDATE redemptions SET status = 'failed', reserved_units = 0 WHERE id = ?").bind(redemptionId),
    ]);
    const detail = error instanceof Error && /^upstream_\d+$/.test(error.message) ? error.message : "El proveedor no respondió.";
    return jsonError("inference_upstream_failed", 502, detail);
  }

  // 4. Settle: bill real usage, refund the rest of the reservation.
  const promptTokens = Math.max(0, Math.floor(result.usage?.prompt_tokens ?? 0));
  const completionUsed = Math.max(0, Math.floor(result.usage?.completion_tokens ?? 0));
  const reported = result.usage && (promptTokens > 0 || completionUsed > 0);
  const usedUnits = reported ? Math.min(Math.max(promptTokens + completionUsed, 1), maxUnits) : maxUnits;
  const refund = maxUnits - usedUnits;
  await db.batch([
    db.prepare("UPDATE vouchers SET remaining_units = remaining_units + ? WHERE id = ?").bind(refund, voucherId),
    db
      .prepare(
        `UPDATE redemptions SET status = 'completed', units = ?, prompt_tokens = ?, completion_tokens = ?, model = ?
         WHERE id = ?`,
      )
      .bind(usedUnits, promptTokens, completionUsed, result.model || model, redemptionId),
  ]);
  const after = await db
    .prepare("SELECT remaining_units AS remainingUnits FROM vouchers WHERE id = ?")
    .bind(voucherId)
    .first<{ remainingUnits: number }>();

  return Response.json(
    {
      redemptionId,
      output: result.choices?.[0]?.message?.content ?? "",
      model: result.model || model,
      usedUnits,
      usage: { promptTokens, completionTokens: completionUsed, billedFromProvider: Boolean(reported) },
      remainingUnits: after?.remainingUnits ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
