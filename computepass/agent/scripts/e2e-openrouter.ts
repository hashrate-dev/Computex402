/**
 * OpenRouter compatibility test, fully local:
 *   fake OpenRouter (mock/openrouter.ts)  <- used as the LLM brain AND as ComputePass's inference provider
 *   ComputePass contract-test server (mock/server.ts, settlement simulated)
 *   LLM agent (src/llmAgent.ts) and OpenAI-compatible gateway (src/gateway.ts)
 * Throwaway in-memory buyer key, never funded.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";

const tsx = join(process.cwd(), "node_modules/.bin/tsx");
const procs: ChildProcess[] = [];
let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failures++;
};
const start = (script: string, env: Record<string, string>, ready: string, args: string[] = []) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(tsx, [script, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(p);
    p.stderr!.on("data", (d) => String(d).includes(ready) && resolve());
    p.on("exit", (c) => reject(new Error(`${script} exited ${c}`)));
  });

const FAKE = "http://localhost:4030/api/v1";
const base = {
  COMPUTEPASS_API_URL: "http://localhost:4022",
  BUYER_PRIVATE_KEY: generatePrivateKey(),
  COMPUTEPASS_STATE_DIR: mkdtempSync(join(tmpdir(), "cp-or-")),
  BUDGET_MAX_PER_PURCHASE: "0.03",
  BUDGET_MAX_PER_DAY: "0.1",
};

try {
  await start("mock/openrouter.ts", { PORT: "4030", FAKE_OPENROUTER_KEY: "sk-test" }, "fake-openrouter");
  await start("mock/server.ts", { PORT: "4022", INFERENCE_API_URL: FAKE, INFERENCE_API_KEY: "sk-test" }, "contract-test");

  // 1. ComputePass inference provider = OpenRouter-compatible API, model chosen per offer.
  const { runLlmAgent } = await import("../src/llmAgent.js");
  Object.assign(process.env, base, { OPENROUTER_API_KEY: "sk-test", LLM_BASE_URL: FAKE, LLM_MODEL: "openai/gpt-4o-mini" });
  const logs: string[] = [];
  const r = await runLlmAgent("Di hola en una frase.", 12, (s) => logs.push(s));
  const tools = r.trace.map((t) => t.tool);
  check(
    "LLM agent ran the full procedure via tool calls",
    JSON.stringify(tools) === JSON.stringify(["list_compute_offers", "quote_inference", "buy_compute_pass", "redeem_inference", "get_execution_receipt"]),
    tools.join(" > "),
  );
  check("all tool calls succeeded", r.trace.every((t) => t.ok));
  check("inference routed to the offer's OpenRouter model", /fake-openrouter meta-llama\/llama-3\.3-70b-instruct/.test(r.answer), r.answer.slice(0, 120));

  // 2. Second task reuses the voucher (no second payment).
  const r2 = await runLlmAgent("Otra pregunta.", 12, () => {});
  check("second task reuses voucher, no purchase", !r2.trace.some((t) => t.tool === "buy_compute_pass") && r2.trace.some((t) => t.tool === "redeem_inference"));

  // 3. OpenAI-compatible gateway: what any OpenRouter/OpenAI SDK client would call.
  await start("src/gateway.ts", { ...base, GATEWAY_TOKEN: "gw-test", GATEWAY_PORT: "8402" }, "gateway");
  const gw = (path: string, init?: RequestInit) =>
    fetch(`http://localhost:8402/v1${path}`, { ...init, headers: { authorization: "Bearer gw-test", "content-type": "application/json", ...(init?.headers ?? {}) } });
  const models: any = await (await gw("/models")).json();
  check("GET /v1/models lists offers + auto", models.data?.map((m: any) => m.id).join(",") === "computepass/llama-70b-burst,computepass/deepseek-r1-flex,computepass/auto");
  const c1: any = await (
    await gw("/chat/completions", { method: "POST", body: JSON.stringify({ model: "meta-llama/llama-3.3-70b-instruct", max_tokens: 64, messages: [{ role: "user", content: "ping" }] }) })
  ).json();
  check("POST /v1/chat/completions (OpenRouter model id) returns chat.completion", c1.object === "chat.completion" && /fake-openrouter meta-llama/.test(c1.choices?.[0]?.message?.content), JSON.stringify(c1).slice(0, 160));
  check("usage and voucher metadata present", c1.usage?.completion_tokens > 0 && !!c1.computepass?.voucher_id);
  const sse = await (
    await gw("/chat/completions", { method: "POST", body: JSON.stringify({ model: "computepass/auto", stream: true, max_tokens: 32, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "pong" }] }) })
  ).text();
  check("stream=true returns SSE chunks ending in [DONE]", /chat\.completion\.chunk/.test(sse) && sse.trim().endsWith("data: [DONE]"));
  const over = await gw("/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek/deepseek-r1", messages: [{ role: "user", content: "x" }] }) });
  check("over-budget model -> 402 insufficient_quota", over.status === 402 && ((await over.json()) as any).error?.type === "insufficient_quota");
  const unauth = await fetch("http://localhost:8402/v1/models");
  check("missing gateway key -> 401", unauth.status === 401);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  for (const p of procs) p.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
