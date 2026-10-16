#!/usr/bin/env node
import { ComputePassClient } from "./api.js";
import { loadConfig } from "./config.js";
import { Ledger } from "./ledger.js";
import { chat, loadLlmConfig, type ChatMessage } from "./openrouter.js";
import { computePassTools, runTool, toOpenAiTools } from "./tools.js";

/**
 * Autonomous agent with an LLM brain on OpenRouter.
 *
 *   OPENROUTER_API_KEY=... BUYER_PRIVATE_KEY=0x... npx tsx src/llmAgent.ts "task" [--max-steps 12]
 *
 * The model decides which ComputePass tools to call; it never sees the wallet
 * key, and every spend still passes the budget checks in code (src/ledger.ts,
 * src/api.ts). The model is untrusted: the budget is the safety boundary.
 */

const SYSTEM = `You are a purchasing agent for AI inference on ComputePass 402.
Goal: get the user's task answered by redeeming inference from a ComputePass voucher, spending as little as possible.
Procedure:
1. Call list_compute_offers, then quote_inference for the units the task needs (default 512).
2. If quote_inference reports coveredByVoucher, use that voucher. Otherwise buy the cheapest quote with withinBudget=true using buy_compute_pass. Never buy more than one pass per task.
3. Call redeem_inference with the user's task as the prompt.
4. Call get_execution_receipt for the voucher.
5. Final answer: the inference output, then one line with voucher id, units used, amount paid (or "reused voucher") and receipt digest.
If a tool returns an error, do not retry the same call more than once; explain the failure instead. Never invent tool results.`;

function parseArgs(argv: string[]) {
  let task: string | undefined;
  let maxSteps = 12;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-steps") maxSteps = Number(argv[++i]);
    else task = argv[i];
  }
  if (!task) throw new Error('usage: llmAgent.ts "task" [--max-steps N]');
  return { task, maxSteps };
}

export async function runLlmAgent(task: string, maxSteps = 12, log: (s: string) => void = console.log) {
  const cfg = loadConfig();
  const llm = loadLlmConfig();
  const ledger = new Ledger(cfg);
  const api = new ComputePassClient(cfg, ledger);
  const tools = computePassTools(cfg, ledger, api);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];
  const trace: { tool: string; args: unknown; ok: boolean }[] = [];
  let buys = 0;

  log(`brain: ${llm.model} via ${llm.baseUrl}  wallet: ${api.address ?? "(none)"}`);
  for (let step = 1; step <= maxSteps; step++) {
    const { message } = await chat(llm, messages, toOpenAiTools(tools));
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    if (!message.tool_calls?.length) {
      log(`\n${message.content ?? ""}`);
      return { answer: message.content ?? "", trace };
    }
    for (const call of message.tool_calls) {
      const tool = byName.get(call.function.name);
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {}
      let result: { ok: boolean; text: string };
      if (!tool) result = { ok: false, text: JSON.stringify({ error: `unknown tool ${call.function.name}` }) };
      // Hard rule in code, not just in the prompt: one purchase per task.
      else if (tool.name === "buy_compute_pass" && buys >= 1)
        result = { ok: false, text: JSON.stringify({ error: "policy: only one purchase per task" }) };
      else {
        result = await runTool(tool, args);
        if (tool.name === "buy_compute_pass" && result.ok) buys++;
      }
      trace.push({ tool: call.function.name, args, ok: result.ok });
      log(`step ${step}: ${call.function.name}(${JSON.stringify(args)}) -> ${result.ok ? "ok" : "error"} ${result.text.slice(0, 160)}`);
      messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
    }
  }
  throw new Error(`stopped after ${maxSteps} steps without a final answer`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { task, maxSteps } = parseArgs(process.argv.slice(2));
  runLlmAgent(task, maxSteps).catch((e) => {
    console.error(`\n✗ ${(e as Error).message}`);
    process.exit(1);
  });
}
