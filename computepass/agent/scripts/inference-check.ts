/**
 * Calls the real inference provider once per offer model with a tiny prompt.
 *   INFERENCE_API_URL=https://openrouter.ai/api/v1 INFERENCE_API_KEY=... npx tsx scripts/inference-check.ts
 */
const url = process.env.INFERENCE_API_URL?.replace(/\/+$/, "");
const key = process.env.INFERENCE_API_KEY;
if (!url || !key) throw new Error("set INFERENCE_API_URL and INFERENCE_API_KEY");
const models = ["meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-r1"];
for (const model of models) {
  const t0 = Date.now();
  const r = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "X-Title": "ComputePass 402" },
    body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
  });
  const j: any = await r.json().catch(() => ({}));
  console.log(JSON.stringify({ model, status: r.status, ms: Date.now() - t0, servedBy: j.model, provider: j.provider, output: j.choices?.[0]?.message?.content?.slice(0, 80), usage: j.usage, error: j.error?.message }));
}
export {};
