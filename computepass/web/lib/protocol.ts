/**
 * Redemption protocol shared by the server, the web client and the agent
 * (computepass/agent imports this file). It must stay dependency-free.
 *
 * v2 binds the signature to the site (domain), the chain, the voucher, the
 * offer (and so the model), the prompt hash and a hard spend cap, and adds a
 * single-use nonce plus a short expiry. A captured signature cannot be
 * replayed, used on another deployment or used after it expires.
 */

export const REDEMPTION_VERSION = 2;
export const CHAIN_ID = 97;
/** A signed intent may be valid for at most this long. */
export const REDEMPTION_MAX_TTL_SECONDS = 600;
export const MAX_PROMPT_CHARS = 16_000;
/** Hard cap on units (prompt + completion tokens) one redemption may debit. */
export const MAX_REDEMPTION_UNITS = 32_000;
/** Cap on completion tokens requested from the provider in one call. */
export const MAX_COMPLETION_TOKENS = 4_096;

export interface RedemptionIntent {
  domain: string;
  chainId: number;
  voucherId: string;
  offerId: string;
  promptSha256: string;
  maxUnits: number;
  nonce: string;
  expiresAt: number;
}

export function redemptionMessage(intent: RedemptionIntent): string {
  return [
    `ComputePass redemption v${REDEMPTION_VERSION}`,
    `Domain: ${intent.domain}`,
    `Chain ID: ${intent.chainId}`,
    `Voucher: ${intent.voucherId}`,
    `Offer: ${intent.offerId}`,
    `Prompt SHA-256: ${intent.promptSha256}`,
    `Max units: ${intent.maxUnits}`,
    `Nonce: ${intent.nonce}`,
    `Expires: ${intent.expiresAt}`,
  ].join("\n");
}

/**
 * Conservative upper estimate of prompt tokens, used to size the completion
 * so that prompt + completion stays under the signed cap. Real usage reported
 * by the provider is what gets billed.
 */
export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(new TextEncoder().encode(prompt).length / 3) + 16;
}

export const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
