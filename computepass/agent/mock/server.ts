#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { verifyMessage, getAddress } from "viem";
import { recoverEip3009Payer, isEip3009PaymentPayload } from "@bnb-chain/b402";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";

/**
 * CONTRACT-TEST SERVER. Not ComputePass, not a payment system.
 *
 * Implements the API documented in the ComputePass 402 project document
 * (section 15) so the MCP server and the reference agent can be tested end to
 * end without the real backend. Payments are verified cryptographically
 * (EIP-3009 signature, payer, amount, asset, payTo, nonce) but settlement is
 * faked: nothing is submitted on-chain. Inference echoes unless
 * INFERENCE_API_URL is set, in which case it calls that OpenAI-compatible API.
 */

const PORT = Number(process.env.PORT ?? 4020);
const NETWORK = "eip155:97";
const ASSET = getAddress("0xc70b8741b8b07a6d61e54fd4b20f22fa648e5565");
const DECIMALS = 18;
const MERCHANT = getAddress(process.env.MERCHANT_ADDRESS ?? "0x000000000000000000000000000000000000dEaD");

const offers = [
  { id: "llama-70b-burst", model: "Llama 3.3 70B", provider: "ComputePass Pool", units: 50000, price: "0.01", latencyMs: 1800, validityDays: 30 },
  { id: "deepseek-r1-flex", model: "DeepSeek R1", provider: "ComputePass Pool", units: 100000, price: "0.018", latencyMs: 3200, validityDays: 30 },
];
const atomic = (p: string) => {
  const [w, f = ""] = p.split(".");
  return (BigInt(w) * 10n ** BigInt(DECIMALS) + BigInt((f + "0".repeat(DECIMALS)).slice(0, DECIMALS))).toString();
};

interface V {
  id: string; offerId: string; owner: string; totalUnits: number; remainingUnits: number;
  paymentNonce: string; txHash: string; status: "active" | "spent" | "expired"; issuedAt: string; expiresAt: string;
}
const vouchers = new Map<string, V>();
const byNonce = new Map<string, string>();
const usedRedemptionSigs = new Set<string>();

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = async (req: IncomingMessage) => {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
};

function requirementsFor(offer: (typeof offers)[number]) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    // MOCK_OVERCHARGE=1 asks 10x the advertised price, to test buyer-side caps.
    amount: (BigInt(atomic(offer.price)) * (process.env.MOCK_OVERCHARGE ? 10n : 1n)).toString(),
    payTo: MERCHANT,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "eip3009", name: "United Stables", version: "1", signerAddress: MERCHANT },
  };
}

async function reservations(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  const offer = offers.find((o) => o.id === body.offerId);
  if (!offer) return send(res, 404, { error: "offer_not_found" });
  if (!/^0x[0-9a-fA-F]{40}$/.test(body.owner ?? "")) return send(res, 400, { error: "invalid_wallet" });
  const reqs = requirementsFor(offer);
  const header = req.headers["payment-signature"];
  if (!header) {
    const pr = { x402Version: 2, error: "payment_required", resource: { url: `http://localhost:${PORT}/api/reservations`, description: offer.id, mimeType: "application/json" }, accepts: [reqs] };
    return send(res, 402, pr, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as never) });
  }
  const payment = decodePaymentSignatureHeader(String(header)) as never as Record<string, any>;
  if (!isEip3009PaymentPayload(payment)) return send(res, 400, { error: "invalid_payment_signature" });
  const a = payment.accepted;
  if (a.network !== reqs.network || getAddress(a.asset) !== ASSET || a.amount !== reqs.amount || getAddress(a.payTo) !== MERCHANT || a.scheme !== "exact")
    return send(res, 400, { error: "payment_requirements_mismatch" });
  const auth = payment.payload.authorization;
  if (getAddress(auth.to) !== MERCHANT || auth.value !== reqs.amount) return send(res, 400, { error: "payment_requirements_mismatch" });
  const payer = getAddress(await recoverEip3009Payer(payment as never));
  if (payer !== getAddress(auth.from)) return send(res, 400, { error: "invalid_payment_signature" });
  if (payer !== getAddress(body.owner)) return send(res, 403, { error: "payer_mismatch" });
  if (BigInt(auth.validBefore) < BigInt(Math.floor(Date.now() / 1000))) return send(res, 400, { error: "payment_expired" });

  const existing = byNonce.get(auth.nonce);
  const txHash = `0x${createHash("sha256").update(auth.nonce).digest("hex")}`; // FAKE settlement hash
  const settle = { success: true, transaction: txHash, network: NETWORK, payer, simulated: true };
  if (existing) return send(res, 200, { voucher: vouchers.get(existing) }, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle as never) });
  const now = new Date();
  const v: V = {
    id: randomUUID(), offerId: offer.id, owner: payer, totalUnits: offer.units, remainingUnits: offer.units,
    paymentNonce: auth.nonce, txHash, status: "active", issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + offer.validityDays * 864e5).toISOString(),
  };
  vouchers.set(v.id, v);
  byNonce.set(auth.nonce, v.id);
  send(res, 201, { voucher: v }, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle as never) });
}

// Provider model per offer (fixes the single INFERENCE_MODEL problem). Override with INFERENCE_MODEL_MAP='{"offer-id":"provider/model"}'.
const MODEL_MAP: Record<string, string> = {
  "llama-70b-burst": "meta-llama/llama-3.3-70b-instruct",
  "deepseek-r1-flex": "deepseek/deepseek-r1",
  ...JSON.parse(process.env.INFERENCE_MODEL_MAP ?? "{}"),
};

async function infer(offerId: string, model: string, prompt: string, maxTokens: number) {
  const url = process.env.INFERENCE_API_URL;
  if (!url) return { text: `[mock inference, ${model}] ${prompt.slice(0, 200)}`, used: Math.min(maxTokens, 1 + Math.ceil(prompt.length / 4)), model: "mock" };
  const r = await fetch(`${url.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.INFERENCE_API_KEY ?? ""}` },
    body: JSON.stringify({ model: MODEL_MAP[offerId] ?? process.env.INFERENCE_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`provider ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return { text: j.choices?.[0]?.message?.content ?? "", used: j.usage?.completion_tokens ?? maxTokens, model: j.model };
}

async function redeem(req: IncomingMessage, res: ServerResponse) {
  const { voucherId, prompt, maxTokens, signature } = await readBody(req);
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000) return send(res, 400, { error: "invalid_prompt" });
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) return send(res, 400, { error: "invalid_units" });
  if (!signature) return send(res, 401, { error: "missing_signature" });
  const v = vouchers.get(voucherId);
  if (!v) return send(res, 404, { error: "voucher_not_found" });
  const hash = createHash("sha256").update(prompt, "utf8").digest("hex");
  const message = `ComputePass redemption\nVoucher: ${voucherId}\nPrompt SHA-256: ${hash}\nUnits: ${maxTokens}`;
  if (!(await verifyMessage({ address: v.owner as `0x${string}`, message, signature }))) return send(res, 401, { error: "invalid_signature" });
  // The real backend lacks this check (see PLAN.md, risk 3); here we at least block exact replays.
  if (usedRedemptionSigs.has(signature)) return send(res, 409, { error: "signature_already_used" });
  if (v.status !== "active" || Date.parse(v.expiresAt) < Date.now()) return send(res, 409, { error: "voucher_inactive" });
  if (v.remainingUnits < maxTokens) return send(res, 402, { error: "insufficient_capacity" });
  usedRedemptionSigs.add(signature);
  v.remainingUnits -= maxTokens;
  const offer = offers.find((o) => o.id === v.offerId)!;
  try {
    const out = await infer(offer.id, offer.model, prompt, maxTokens);
    v.remainingUnits += maxTokens - out.used;
    if (v.remainingUnits === 0) v.status = "spent";
    send(res, 200, { redemptionId: randomUUID(), output: out.text, model: out.model, unitsUsed: out.used, remainingUnits: v.remainingUnits });
  } catch (e) {
    v.remainingUnits += maxTokens;
    send(res, 502, { error: "inference_failed", detail: (e as Error).message });
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/api/status")
      return send(res, 200, { network: NETWORK, chain: "BSC Testnet", token: ASSET, facilitator: "SIMULATED", settlement: "simulated", inference: process.env.INFERENCE_API_URL ? "configured" : "mock", contract: "offchain" });
    if (req.method === "GET" && url.pathname === "/api/offers") return send(res, 200, { offers });
    if (req.method === "GET" && url.pathname === "/api/vouchers") {
      const owner = url.searchParams.get("owner")?.toLowerCase();
      return send(res, 200, { vouchers: [...vouchers.values()].filter((v) => v.owner.toLowerCase() === owner).reverse().slice(0, 50) });
    }
    if (req.method === "POST" && url.pathname === "/api/reservations") return await reservations(req, res);
    if (req.method === "POST" && url.pathname === "/api/redeem") return await redeem(req, res);
    send(res, 404, { error: "not_found" });
  } catch (e) {
    send(res, 500, { error: "internal", detail: (e as Error).message });
  }
}).listen(PORT, () => console.error(`contract-test server on http://localhost:${PORT} (settlement SIMULATED)`));
