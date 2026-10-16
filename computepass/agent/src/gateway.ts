#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ComputePassClient, type Offer } from "./api.js";
import { loadConfig } from "./config.js";
import { BudgetError, Ledger } from "./ledger.js";
import { quote, usableVoucher } from "./planner.js";
import { estimatePromptTokens } from "../../web/lib/protocol.js";

/**
 * OpenAI / OpenRouter-compatible gateway in front of ComputePass vouchers.
 *
 *   GATEWAY_TOKEN=... BUYER_PRIVATE_KEY=0x... npx tsx src/gateway.ts [port]
 *
 * Any OpenAI or OpenRouter SDK client can point its baseURL at
 * http://localhost:8402/v1 and call chat.completions. The gateway picks a
 * voucher with enough balance (buying one within budget if none), signs the
 * redemption with the local wallet and returns an OpenAI-shaped response.
 *
 * It runs next to the buyer (it holds the buyer key), not on the ComputePass
 * backend: the backend's /api/redeem needs a wallet signature that plain
 * OpenAI clients cannot produce.
 */

const cfg = loadConfig();
const ledger = new Ledger(cfg);
const api = new ComputePassClient(cfg, ledger);
const PORT = Number(process.argv[2] ?? process.env.GATEWAY_PORT ?? 8402);
const TOKEN = process.env.GATEWAY_TOKEN;
const DEFAULT_MAX_TOKENS = 512;

// OpenRouter model ids accepted as aliases of ComputePass offers.
const ALIASES: Record<string, string> = {
  "meta-llama/llama-3.3-70b-instruct": "llama-70b-burst",
  "deepseek/deepseek-r1": "deepseek-r1-flex",
  ...JSON.parse(process.env.GATEWAY_MODEL_ALIASES ?? "{}"),
};

type Msg = { role: string; content: string | { type: string; text?: string }[] | null };

const text = (c: Msg["content"]) =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("") : "";

/** The backend takes a single prompt, so chat history is flattened with role labels. */
export function flatten(messages: Msg[]): string {
  if (messages.length === 1 && messages[0].role === "user") return text(messages[0].content);
  return messages.map((m) => `${m.role.toUpperCase()}: ${text(m.content)}`).join("\n\n") + "\n\nASSISTANT:";
}

function oaiError(res: ServerResponse, status: number, message: string, type: string) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, code: status } }));
}

async function resolveOffer(model: string, offers: Offer[], units: number): Promise<Offer | undefined> {
  if (model === "computepass/auto" || model === "auto") {
    return quote(offers, { units }, cfg, ledger.budgetStatus().remainingToday).find((q) => q.withinBudget)?.offer;
  }
  const id = ALIASES[model] ?? model.replace(/^computepass\//, "");
  return offers.find((o) => o.id === id);
}

async function models(res: ServerResponse) {
  const offers = await api.offers();
  const created = Math.floor(Date.now() / 1000);
  const data = offers.map((o) => ({
    id: `computepass/${o.id}`,
    object: "model",
    created,
    owned_by: o.provider ?? "computepass",
    name: o.model,
    aliases: Object.entries(ALIASES).filter(([, v]) => v === o.id).map(([k]) => k),
    context_length: 16000 / 4, // prompt limit is 16,000 characters
    pricing: { pass_price_u: o.price, units_per_pass: o.units, u_per_1k_units: o.pricePerKUnits },
  }));
  data.push({ id: "computepass/auto", object: "model", created, owned_by: "computepass", name: "Cheapest offer within budget", aliases: [], context_length: 4000, pricing: {} as never });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ object: "list", data }));
}

async function completions(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    let s = "";
    for await (const c of req) s += c;
    body = JSON.parse(s);
  } catch {
    return oaiError(res, 400, "invalid JSON body", "invalid_request_error");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) return oaiError(res, 400, "messages is required", "invalid_request_error");
  if (body.tools?.length) return oaiError(res, 400, "tool calling is not supported by ComputePass vouchers", "invalid_request_error");
  const maxTokens = Math.min(4096, Math.max(1, Number(body.max_tokens ?? body.max_completion_tokens ?? DEFAULT_MAX_TOKENS)));
  const prompt = flatten(body.messages);
  if (prompt.length > 16000) return oaiError(res, 400, "prompt exceeds 16,000 characters", "invalid_request_error");
  // Vouchers bill prompt + completion tokens, so the signed cap covers both.
  const units = estimatePromptTokens(prompt.trim()) + maxTokens;

  const offers = await api.offers();
  const offer = await resolveOffer(String(body.model ?? "computepass/auto"), offers, units);
  if (!offer) return oaiError(res, 404, `unknown model or no offer within budget: ${body.model}`, "invalid_request_error");

  try {
    const mine = (await api.vouchers()).filter((v) => v.offerId === offer.id);
    let voucher = usableVoucher(mine, offers, { units });
    if (!voucher) voucher = (await api.buy(offer.id)).voucher;
    const r = await api.redeem(voucher.id, prompt, units);
    const id = `chatcmpl-${r.redemptionId ?? randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: r.promptTokens ?? 0, completion_tokens: r.completionTokens ?? 0, total_tokens: r.unitsUsed ?? 0 };
    const meta = { voucher_id: voucher.id, remaining_units: r.remainingUnits, receipt_id: r.receiptId };
    const model = `computepass/${offer.id}`;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: object, finish: string | null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant", content: r.output }, null);
      chunk({}, "stop");
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage, computepass: meta })}\n\n`);
      return void res.end("data: [DONE]\n\n");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: r.output }, finish_reason: "stop" }],
        usage,
        computepass: meta,
      }),
    );
  } catch (e) {
    if (e instanceof BudgetError) return oaiError(res, 402, e.message, "insufficient_quota");
    return oaiError(res, 502, (e as Error).message, "upstream_error");
  }
}

if (!TOKEN) throw new Error("GATEWAY_TOKEN is required");
createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return oaiError(res, 401, "invalid API key", "authentication_error");
  try {
    if (req.method === "GET" && url.pathname === "/v1/models") return await models(res);
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await completions(req, res);
    oaiError(res, 404, "not found", "invalid_request_error");
  } catch (e) {
    oaiError(res, 502, (e as Error).message, "upstream_error");
  }
}).listen(PORT, () => console.error(`ComputePass OpenAI-compatible gateway on http://localhost:${PORT}/v1`));
