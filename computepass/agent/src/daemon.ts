#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, erc20Abi, http, type Hex } from "viem";
import { bscTestnet } from "viem/chains";
import { ApiError, ComputePassClient, type Offer } from "./api.js";
import { fromAtomic, loadConfig, type Config } from "./config.js";
import { BudgetError, Ledger } from "./ledger.js";
import { quote, usableVoucher } from "./planner.js";
import { MAX_REDEMPTION_UNITS } from "../../web/lib/protocol.js";

/**
 * Long-running buyer agent, controlled from the site's /admin panel.
 *
 *   AGENT_TOKEN=... COMPUTEPASS_API_URL=http://127.0.0.1:8788 npx tsx src/daemon.ts [--once]
 *
 * Every AGENT_POLL_SECONDS it checks in at POST /api/agent/sync: reports the
 * wallet balance and the results of finished tasks, and gets back the
 * settings (paused, caps) and at most one queued task. For each task it reuses
 * a voucher with enough balance or buys the cheapest offer inside the caps,
 * redeems, and reports what it did.
 *
 * Safety:
 * - The key never leaves this machine: BUYER_PRIVATE_KEY, or the file
 *   TESTNET_BUYER_KEY_FILE (default ~/.computepass/testnet-buyer.key).
 * - Effective caps = the stricter of the local BUDGET_* variables and the
 *   panel's caps. The panel can stop the agent or make it spend less, never more.
 * - It only works when the site says it is not paused; if the site is
 *   unreachable it does nothing (fails closed).
 * - BSC testnet only.
 */

const VERSION = "0.3.0";
const once = process.argv.includes("--once");
const pollMs = Math.max(5, Number(process.env.AGENT_POLL_SECONDS ?? 15)) * 1000;

interface RemoteSettings {
  paused: boolean;
  maxPerPurchaseAtomic: string | null;
  maxPerDayAtomic: string | null;
  maxUnitsPerRedeem: number | null;
  allowedOffers: string[] | null;
}
interface Task {
  id: string;
  prompt: string;
  units: number;
  model: string | null;
}
interface TaskResult {
  taskId: string;
  status: "done" | "failed";
  voucherId?: string;
  unitsUsed?: number;
  paidAtomic?: string;
  resultText?: string;
  error?: string;
}
interface AgentEvent {
  kind: "purchase" | "reuse" | "redeem" | "refused" | "error" | "info";
  message: string;
  taskId?: string;
}

const log = (msg: string) => console.log(`${new Date().toISOString()}  ${msg}`);

function loadKey(): string {
  if (process.env.BUYER_PRIVATE_KEY?.trim()) return process.env.BUYER_PRIVATE_KEY.trim();
  const file = process.env.TESTNET_BUYER_KEY_FILE ?? join(homedir(), ".computepass", "testnet-buyer.key");
  if (!existsSync(file)) {
    throw new Error(`no buyer key: set BUYER_PRIVATE_KEY or create ${file} (npm run testnet-buy creates one)`);
  }
  return readFileSync(file, "utf8").trim();
}

/** The stricter of the local caps and the panel's caps. */
export function effectiveBudget(local: Config["budget"], remote: RemoteSettings, decimals: number): Config["budget"] {
  const min = (a: number, atomic: string | null) => (atomic === null ? a : Math.min(a, fromAtomic(atomic, decimals)));
  const allowed =
    local.allowedOffers && remote.allowedOffers
      ? local.allowedOffers.filter((id) => remote.allowedOffers!.includes(id))
      : (local.allowedOffers ?? remote.allowedOffers ?? undefined);
  return {
    maxPerPurchase: min(local.maxPerPurchase, remote.maxPerPurchaseAtomic),
    maxPerDay: min(local.maxPerDay, remote.maxPerDayAtomic),
    maxUnitsPerRedeem: Math.min(local.maxUnitsPerRedeem, remote.maxUnitsPerRedeem ?? Infinity, MAX_REDEMPTION_UNITS),
    allowedOffers: allowed,
    allowedModels: local.allowedModels,
  };
}

export async function runTask(task: Task, cfg: Config, emit: (e: AgentEvent) => void): Promise<TaskResult> {
  const ledger = new Ledger(cfg);
  const api = new ComputePassClient(cfg, ledger);
  const units = Math.min(task.units, cfg.budget.maxUnitsPerRedeem);
  const need = { units, model: task.model ?? undefined };
  try {
    const offers: Offer[] = await api.offers();
    let voucher = usableVoucher(await api.vouchers(), offers, need);
    let paidAtomic: string | undefined;
    if (voucher) {
      emit({ kind: "reuse", message: `Uso el voucher ${voucher.id.slice(0, 8)} (${voucher.remainingUnits} unidades), sin pagar`, taskId: task.id });
    } else {
      const quotes = quote(offers, need, cfg, ledger.budgetStatus().remainingToday);
      const best = quotes.find((q) => q.withinBudget && q.passesNeeded === 1);
      if (!best) {
        const why = quotes.map((q) => `${q.offer.id}: ${q.reason ?? "necesita más de un pase"}`).join("; ") || "ninguna oferta sirve para el modelo pedido";
        emit({ kind: "refused", message: `No compro: ${why}`, taskId: task.id });
        return { taskId: task.id, status: "failed", error: `ninguna oferta entra en los topes (${why})` };
      }
      const bought = await api.buy(best.offer.id);
      voucher = bought.voucher;
      const raw = best.offer.raw as { priceAtomic?: string };
      paidAtomic = raw.priceAtomic;
      const tx = (bought.settlement?.transaction as string | undefined) ?? voucher.txHash ?? "";
      emit({ kind: "purchase", message: `Compré ${best.offer.id} por ${bought.paid} U${tx ? ` (tx ${tx})` : ""}`, taskId: task.id });
    }
    const r = await api.redeem(voucher.id, task.prompt, units);
    emit({ kind: "redeem", message: `Redimí ${r.unitsUsed ?? "?"} unidades con ${r.model ?? "el modelo de la oferta"}; quedan ${r.remainingUnits ?? "?"}`, taskId: task.id });
    return { taskId: task.id, status: "done", voucherId: voucher.id, unitsUsed: r.unitsUsed, paidAtomic, resultText: r.output };
  } catch (e) {
    const err = e as Error;
    const kind = err instanceof BudgetError ? "refused" : "error";
    const message = err instanceof ApiError ? `${err.message}` : `${err.name}: ${err.message}`;
    emit({ kind, message: message.slice(0, 400), taskId: task.id });
    return { taskId: task.id, status: "failed", error: message.slice(0, 400) };
  }
}

async function main() {
  const local = loadConfig({ ...process.env, BUYER_PRIVATE_KEY: loadKey() });
  const token = process.env.AGENT_TOKEN;
  if (!token || token.length < 32) throw new Error("AGENT_TOKEN (32+ characters, the same one configured on the site) is required");
  if (local.network !== "eip155:97") throw new Error(`testnet only: COMPUTEPASS_NETWORK is ${local.network}`);
  const address = local.account!.address;
  const chain = createPublicClient({ chain: bscTestnet, transport: http(process.env.BSC_RPC_URL, { timeout: 10_000 }) });

  const pendingResults: TaskResult[] = [];
  const pendingEvents: AgentEvent[] = [];
  let lastError: string | null = null;
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("deteniendo después de la tarea actual (Ctrl-C otra vez para salir ya)");
  });

  log(`agente ${VERSION} · wallet ${address} · ${local.apiUrl}`);
  log(`topes locales: ${local.budget.maxPerPurchase} U por compra, ${local.budget.maxPerDay} U por día, ${local.budget.maxUnitsPerRedeem} unidades por redención`);

  /** One check-in plus at most one task. Returns true when there is more to do right away. */
  async function tick(): Promise<boolean> {
    const balance = await chain
      .readContract({ address: local.paymentAsset as Hex, abi: erc20Abi, functionName: "balanceOf", args: [address] })
      .then((b) => b.toString())
      .catch(() => null);
    const results = pendingResults.slice();
    const events = pendingEvents.slice(0, 20);
    let res: Response;
    try {
      res = await fetch(`${local.apiUrl}/api/agent/sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ address, balanceAtomic: balance, localBudget: local.budget, version: VERSION, error: lastError, results, events, claim: !stopping }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      log(`no pude hablar con el sitio (${(e as Error).message}); no hago nada hasta reconectar`);
      return false;
    }
    if (!res.ok) {
      log(`el sitio respondió ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
      if (res.status === 401 || res.status === 404) log("revisá que AGENT_TOKEN sea el mismo en el sitio y en este proceso");
      return false;
    }
    pendingResults.splice(0, results.length);
    pendingEvents.splice(0, events.length);
    lastError = null;
    const { settings, tasks } = (await res.json()) as { settings: RemoteSettings; tasks: Task[] };
    if (settings.paused || !tasks.length) return pendingResults.length + pendingEvents.length > 0;

    const cfg: Config = { ...local, budget: effectiveBudget(local.budget, settings, local.assetDecimals) };
    for (const task of tasks) {
      log(`tarea ${task.id.slice(0, 8)}: ${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? "…" : ""}`);
      const result = await runTask(task, cfg, (e) => {
        pendingEvents.push(e);
        log(`  ${e.kind}: ${e.message}`);
      });
      if (result.status === "failed") lastError = result.error ?? "task failed";
      pendingResults.push(result);
    }
    return true;
  }

  for (let rounds = 0; ; rounds++) {
    const more = await tick().catch((e) => {
      lastError = (e as Error).message;
      log(`error: ${lastError}`);
      return false;
    });
    if (once && (!more || rounds > 20)) break;
    if (stopping && !pendingResults.length) break;
    if (!more) await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  });
}
