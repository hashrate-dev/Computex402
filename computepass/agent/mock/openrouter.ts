#!/usr/bin/env node
import { createServer } from "node:http";

/**
 * FAKE OpenRouter for tests (openrouter.ai is not reachable from the build
 * environment). Speaks the OpenAI /chat/completions wire format:
 *  - with `tools`: a scripted "brain" that walks the ComputePass procedure,
 *    reading real tool results from the conversation;
 *  - without `tools`: an inference provider that echoes, naming the model.
 * It is not a language model and proves only the wire format and the loop.
 */

const PORT = Number(process.env.PORT ?? 4030);
const KEY = process.env.FAKE_OPENROUTER_KEY ?? "test-key";
let n = 0;

function brain(messages: any[]): any {
  const tools = messages.filter((m) => m.role === "tool");
  const last = tools.at(-1) ? JSON.parse(tools.at(-1).content) : null;
  const lastCall = [...messages].reverse().find((m) => m.tool_calls)?.tool_calls?.[0]?.function?.name;
  const task = messages.find((m) => m.role === "user").content;
  const call = (name: string, args: object) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  const voucherOf = () => {
    for (const m of [...tools].reverse()) {
      const j = JSON.parse(m.content);
      if (j.voucher?.id) return j.voucher.id;
      if (j.coveredByVoucher?.id) return j.coveredByVoucher.id;
    }
  };
  if (!lastCall) return call("list_compute_offers", {});
  if (last?.error) return { role: "assistant", content: `Could not complete: ${last.error}` };
  if (lastCall === "list_compute_offers") return call("quote_inference", { units: 256 });
  if (lastCall === "quote_inference") {
    if (last.coveredByVoucher) return call("redeem_inference", { voucherId: last.coveredByVoucher.id, prompt: task, maxUnits: 256 });
    const best = last.quotes.find((q: any) => q.withinBudget);
    if (!best) return { role: "assistant", content: "No offer fits the budget." };
    return call("buy_compute_pass", { offerId: best.offer.id });
  }
  if (lastCall === "buy_compute_pass") return call("redeem_inference", { voucherId: last.voucher.id, prompt: task, maxUnits: 256 });
  if (lastCall === "redeem_inference") return call("get_execution_receipt", { voucherId: voucherOf() });
  if (lastCall === "get_execution_receipt")
    return { role: "assistant", content: `ANSWER: ${JSON.stringify(tools.find((m) => JSON.parse(m.content).output)?.content)}\nvoucher ${voucherOf()} digest ${last.digest}` };
  return { role: "assistant", content: "done" };
}

createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }));
  }
  let s = "";
  for await (const c of req) s += c;
  const body = JSON.parse(s || "{}");
  const message = body.tools?.length
    ? brain(body.messages)
    : { role: "assistant", content: `[fake-openrouter ${body.model}] ${String(body.messages.at(-1).content).slice(0, 120)}` };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `gen-${++n}`,
      model: body.model,
      provider: "FakeProvider",
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: Math.min(body.max_tokens ?? 50, 42), total_tokens: 52 },
    }),
  );
}).listen(PORT, () => console.error(`fake-openrouter on http://localhost:${PORT}/api/v1`));
