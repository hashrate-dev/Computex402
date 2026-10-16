/**
 * End-to-end contract test against mock/server.ts (settlement simulated).
 * Uses a throwaway key generated in memory; it never holds funds.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = "4020";
const key = generatePrivateKey();
const stateDir = mkdtempSync(join(tmpdir(), "cp-e2e-"));
const env = {
  ...process.env,
  COMPUTEPASS_API_URL: `http://localhost:${PORT}`,
  BUYER_PRIVATE_KEY: key,
  COMPUTEPASS_STATE_DIR: stateDir,
  BUDGET_MAX_PER_PURCHASE: "0.015",
  BUDGET_MAX_PER_DAY: "0.05",
};
let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failures++;
};
const tsx = join(process.cwd(), "node_modules/.bin/tsx");
const run = (args: string[], extra: Record<string, string> = {}) => {
  try {
    return { code: 0, out: execFileSync(tsx, args, { env: { ...env, ...extra }, encoding: "utf8" }) };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout}${e.stderr}` };
  }
};

const server = spawn(tsx, ["mock/server.ts"], { env: { ...env, PORT }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise<void>((resolve) => server.stderr.on("data", (d) => String(d).includes("contract-test") && resolve()));

try {
  // 1. Agent buys the cheapest pass within budget (Llama: DeepSeek 0.018 > 0.015 cap) and redeems.
  const r1 = run(["src/agent.ts", "Explain x402 in one sentence.", "--units", "256"]);
  check("agent run 1 exits 0", r1.code === 0, r1.code ? r1.out.slice(-400) : "");
  check("agent paid via x402", /Pay via x402/.test(r1.out) && /llama-70b-burst/.test(r1.out));
  check("DeepSeek refused by per-purchase cap", /✗ deepseek-r1-flex.*per-purchase cap/.test(r1.out));
  check("agent got inference output", /\[mock inference/.test(r1.out));
  check("receipt has purchase and redemption", /"kind": "purchase"/.test(r1.out) && /"kind": "redemption"/.test(r1.out));

  // 2. Second run reuses the voucher instead of paying again.
  const r2 = run(["src/agent.ts", "Second prompt.", "--units", "256"]);
  check("agent run 2 reuses voucher", r2.code === 0 && /Reuse existing voucher/.test(r2.out) && !/Pay via x402/.test(r2.out));

  // 3. Budget: a daily cap below the price blocks payment before any signature.
  const r3 = run(["src/agent.ts", "x", "--model", "deepseek"], { BUDGET_MAX_PER_PURCHASE: "1", BUDGET_MAX_PER_DAY: "0.015" });
  check("daily cap blocks purchase", r3.code !== 0 && /no offer fits/.test(r3.out), r3.out.split("\n").slice(-2).join(" "));

  // 4. A server that asks more than it advertised is refused by the x402 spend controls (no signature sent).
  const over = spawn(tsx, ["mock/server.ts"], { env: { ...env, PORT: "4021", MOCK_OVERCHARGE: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((resolve) => over.stderr.on("data", (d) => String(d).includes("contract-test") && resolve()));
  const r4 = run(["src/agent.ts", "x"], { COMPUTEPASS_API_URL: "http://localhost:4021", COMPUTEPASS_STATE_DIR: mkdtempSync(join(tmpdir(), "cp-e2e-")) });
  over.kill();
  check("overcharging 402 refused before signing", r4.code !== 0 && /BudgetError/.test(r4.out), r4.out.split("\n").filter(Boolean).slice(-1)[0]);

  // 5. MCP server over stdio.
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: tsx, args: ["src/mcp.ts"], env: env as Record<string, string> }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(
    "MCP exposes the 6 tools",
    JSON.stringify(tools) ===
      JSON.stringify(["buy_compute_pass", "get_execution_receipt", "get_voucher_balance", "list_compute_offers", "quote_inference", "redeem_inference"]),
    tools.join(","),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content[0].text as string;
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  const offers = await call("list_compute_offers");
  check("list_compute_offers", offers.json?.offers?.length === 2);
  const q = await call("quote_inference", { units: 1000, model: "deepseek" });
  check("quote_inference flags DeepSeek over cap", q.json?.quotes?.[0]?.withinBudget === false);
  const bought = await call("buy_compute_pass", { offerId: "llama-70b-burst" });
  check("buy_compute_pass issues voucher", !!bought.json?.voucher?.id, bought.isError ? bought.text : "");
  const refused = await call("buy_compute_pass", { offerId: "deepseek-r1-flex" });
  check("buy_compute_pass refuses over-budget offer", refused.isError && /BudgetError/.test(refused.text), refused.text.slice(0, 120));
  const vid = bought.json?.voucher?.id;
  const red = await call("redeem_inference", { voucherId: vid, prompt: "hola", maxUnits: 64 });
  check("redeem_inference returns output", !red.isError && /mock inference/.test(red.json?.output ?? ""), red.isError ? red.text : "");
  const bal = await call("get_voucher_balance", { voucherId: vid });
  check("get_voucher_balance reflects consumption", bal.json?.remainingUnits === 50000 - red.json?.unitsUsed);
  const rc = await call("get_execution_receipt", { voucherId: vid });
  check("get_execution_receipt has digest and 2 records", rc.json?.records?.length === 2 && /^[0-9a-f]{64}$/.test(rc.json?.digest));
  await client.close();
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
