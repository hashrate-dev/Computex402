#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getAddress } from "viem";
import { recoverEip3009Payer } from "@bnb-chain/b402";
import { offers } from "../../web/lib/catalog.js";
import { REDEMPTION_VERSION } from "../../web/lib/protocol.js";
import { handleRedeem } from "../../web/lib/server/redeem.js";
import { handleReservation } from "../../web/lib/server/reservations.js";
import { handleListVouchers } from "../../web/lib/server/vouchers.js";
import type { Deps } from "../../web/lib/server/types.js";
import { createTestDb } from "../../web/tests/d1-sqlite.js";

/**
 * CONTRACT-TEST SERVER. Runs the real ComputePass route handlers
 * (computepass/web/lib/server) on Node with an in-memory SQLite database
 * loaded from the real migrations, so the agent is tested against the code
 * that ships, not a copy. Needs `npm ci` in computepass/web.
 *
 * Only two things are fake:
 * - the x402 facilitator: /verify really recovers the EIP-3009 signer, but
 *   /settle submits nothing on-chain and returns a made-up tx hash;
 * - inference, unless INFERENCE_API_URL is set: an echo with token usage.
 *
 * MOCK_OVERCHARGE=1 advertises a tenth of the real price in /api/offers, so the
 * 402 asks 10x what was advertised (to test buyer-side spend caps).
 */

const PORT = Number(process.env.PORT ?? 4020);
const MERCHANT = getAddress(process.env.MERCHANT_ADDRESS ?? "0x000000000000000000000000000000000000dEaD");
const FACILITATOR = "http://facilitator.invalid";
const ECHO_INFERENCE = "http://echo-inference.invalid/v1";

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(FACILITATOR)) {
    const body = JSON.parse(String(init?.body));
    const auth = body.paymentPayload.payload.authorization;
    if (url.endsWith("/verify")) {
      const payer = await recoverEip3009Payer(body.paymentPayload);
      const ok = getAddress(payer) === getAddress(auth.from);
      return Response.json({ isValid: ok, invalidReason: ok ? undefined : "invalid_signature" });
    }
    return Response.json({ success: true, transaction: `0x${auth.nonce.slice(2)}`, network: "eip155:97", payer: auth.from });
  }
  if (url.startsWith(ECHO_INFERENCE)) {
    const body = JSON.parse(String(init?.body));
    const prompt = String(body.messages.at(-1).content);
    const completion = Math.min(body.max_tokens, 1 + Math.ceil(prompt.length / 4));
    return Response.json({
      model: body.model,
      choices: [{ message: { content: `[mock inference, ${body.model}] ${prompt.slice(0, 200)}` } }],
      usage: { prompt_tokens: 8 + Math.ceil(prompt.length / 4), completion_tokens: completion },
    });
  }
  return fetch(input, init);
}) as typeof fetch;

const deps: Deps = {
  db: createTestDb(),
  env: {
    MERCHANT_ADDRESS: MERCHANT,
    FACILITATOR_URL: FACILITATOR,
    INFERENCE_API_URL: process.env.INFERENCE_API_URL ?? ECHO_INFERENCE,
    INFERENCE_API_KEY: process.env.INFERENCE_API_KEY ?? "mock",
  },
  fetch: fakeFetch,
  now: () => Math.floor(Date.now() / 1000),
};

const advertised = process.env.MOCK_OVERCHARGE
  ? offers.map((o) => ({ ...o, priceAtomic: (BigInt(o.priceAtomic) / 10n).toString() }))
  : offers;

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

async function send(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    if (route === "GET /api/status")
      return send(res, Response.json({ network: "eip155:97", chainId: 97, chainName: "BSC Testnet", facilitator: "SIMULATED", redemptionProtocol: REDEMPTION_VERSION, ready: { payment: true, inference: true, contract: false } }));
    if (route === "GET /api/offers") return send(res, Response.json({ offers: advertised }));
    if (route === "GET /api/vouchers") return send(res, await handleListVouchers(request, deps));
    if (route === "POST /api/reservations") return send(res, await handleReservation(request, deps));
    if (route === "POST /api/redeem") return send(res, await handleRedeem(request, deps));
    send(res, Response.json({ error: "not_found" }, { status: 404 }));
  } catch (e) {
    send(res, Response.json({ error: "internal", detail: (e as Error).message }, { status: 500 }));
  }
}).listen(PORT, () => console.error(`contract-test server on http://localhost:${PORT} (real handlers, settlement SIMULATED)`));
