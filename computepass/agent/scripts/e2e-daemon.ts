/**
 * End-to-end test of the panel-controlled agent (src/daemon.ts) against
 * mock/server.ts, which runs the real /api/admin/agent and /api/agent/sync
 * handlers. Settlement is simulated; the key is a throwaway with no funds.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";

const PORT = "4022";
const API = `http://localhost:${PORT}`;
const ADMIN_TOKEN = "admin-".padEnd(40, "a");
const AGENT_TOKEN = "agent-".padEnd(40, "g");
const env = {
  ...process.env,
  COMPUTEPASS_API_URL: API,
  BUYER_PRIVATE_KEY: generatePrivateKey(),
  COMPUTEPASS_STATE_DIR: mkdtempSync(join(tmpdir(), "cp-daemon-")),
  BUDGET_MAX_PER_PURCHASE: "0.03",
  BUDGET_MAX_PER_DAY: "0.1",
  BSC_RPC_URL: "http://rpc.invalid",
  AGENT_TOKEN,
  ADMIN_TOKEN,
  AGENT_POLL_SECONDS: "5",
};
let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? "  " + detail : ""}`);
  if (!cond) failures++;
};
const tsx = join(process.cwd(), "node_modules/.bin/tsx");
const daemon = (extra: Record<string, string> = {}) => {
  try {
    return execFileSync(tsx, ["src/daemon.ts", "--once"], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
  } catch (e: any) {
    return `EXIT ${e.status}\n${e.stdout}${e.stderr}`;
  }
};
const admin = async (body?: unknown): Promise<any> => {
  const res = await fetch(`${API}/api/admin/agent`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
};
const task = async (id: string) => (await admin()).tasks.find((t: { id: string }) => t.id === id);

const server = spawn(tsx, ["mock/server.ts"], { env: { ...env, PORT }, stdio: ["ignore", "ignore", "pipe"] });
await new Promise<void>((resolve) => server.stderr.on("data", (d) => String(d).includes("contract-test") && resolve()));

try {
  // 1. Paused by default: the agent checks in but takes no work.
  const a = (await admin({ action: "task", prompt: "Explain x402 in one sentence.", units: 256 })).taskId;
  daemon();
  let view = await admin();
  check("agent checked in and shows its wallet", view.agent?.online === true && /^0x/.test(view.wallet?.address ?? ""));
  check("paused by default: task stays queued", (await task(a)).status === "queued");

  // 2. Turned on, with a panel cap below the Llama price (0.025 U): refused before any signature.
  await admin({ action: "settings", paused: false, maxPerPurchase: "0.02" });
  daemon();
  const t0 = await task(a);
  check("panel cap below the price refuses the purchase", t0.status === "failed" && /per-purchase cap 0.02 U/.test(t0.error ?? ""), t0.error);
  check("nothing was paid", (await admin()).wallet.payments.length === 0);

  // 3. Cap cleared: buys the cheapest pass inside the local caps and redeems.
  await admin({ action: "settings", maxPerPurchase: "" });
  const a2 = (await admin({ action: "task", prompt: "Explain x402 in one sentence.", units: 256 })).taskId;
  const out2 = daemon();
  const ta = await task(a2);
  check("task done after clearing the cap", ta.status === "done", ta.error ?? out2.slice(-300));
  check("paid for llama inside the caps", ta.paidAtomic === "25000000000000000" && /purchase: Compré llama-70b-burst/.test(out2));
  check("result reached the panel", /\[mock inference/.test(ta.resultText ?? ""));

  // 4. A second task reuses the voucher instead of paying again.
  const b = (await admin({ action: "task", prompt: "Second prompt.", units: 256 })).taskId;
  const out3 = daemon();
  const tb = await task(b);
  check("second task reuses the voucher", tb.status === "done" && !tb.paidAtomic && /reuse:/.test(out3));

  // 5. The panel cannot loosen the local caps (local per-purchase cap is 0.03 U).
  await admin({ action: "settings", maxPerDay: "", maxPerPurchase: "5" });
  const d = (await admin({ action: "task", prompt: "x", units: 256, model: "deepseek" })).taskId;
  daemon();
  const td = await task(d);
  check("panel cannot raise the local cap", td.status === "failed" && /per-purchase cap 0.03/.test(td.error ?? ""), td.error);

  // 6. Pausing from the panel stops work.
  await admin({ action: "settings", paused: true });
  const e = (await admin({ action: "task", prompt: "after pause", units: 64 })).taskId;
  daemon();
  check("paused agent leaves the task queued", (await task(e)).status === "queued");

  // 7. A wrong agent token gets nothing.
  await admin({ action: "settings", paused: false });
  const out7 = daemon({ AGENT_TOKEN: "wrong".padEnd(40, "x") });
  check("wrong agent token does nothing", /401/.test(out7) && (await task(e)).status === "queued");

  // 8. The panel shows money and usage from the site's own records.
  view = await admin();
  check("panel shows one purchase and spend today", view.wallet.payments.length === 1 && view.wallet.spentTodayAtomic === "25000000000000000");
  check("panel shows usage", view.wallet.unitsUsedTotal > 0 && view.wallet.redemptionsTotal === 2);
  check("panel shows the agent's decisions", ["purchase", "reuse", "redeem", "refused"].every((k) => view.events.some((ev: { kind: string }) => ev.kind === k)));
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nall daemon checks passed");
process.exit(failures ? 1 : 0);
