import { z } from "zod";
import { ComputePassClient } from "./api.js";
import type { Config } from "./config.js";
import type { Ledger } from "./ledger.js";
import { quote, usableVoucher } from "./planner.js";

/**
 * The six ComputePass tools, defined once and served two ways: as MCP tools
 * (src/mcp.ts) and as OpenAI/OpenRouter function-calling tools (src/llmAgent.ts).
 */

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  run: (args: any) => Promise<unknown>;
}

const strip = <T extends { raw: unknown }>(x: T) => {
  const { raw: _raw, ...rest } = x;
  return rest;
};

export function computePassTools(cfg: Config, ledger: Ledger, api: ComputePassClient): ToolDef[] {
  return [
    {
      name: "list_compute_offers",
      description:
        "List ComputePass inference offers (model, units per pass, price in U testnet, latency target, validity), plus the backend's infrastructure status.",
      shape: {},
      readOnly: true,
      run: async () => {
        const [offers, status] = await Promise.all([api.offers(), api.status().catch((e) => ({ error: (e as Error).message }))]);
        return { offers: offers.map(strip), status };
      },
    },
    {
      name: "quote_inference",
      description:
        "Price a job across offers, cheapest first, checked against the agent's budget. Also reports whether an existing voucher already covers it.",
      shape: {
        units: z.number().int().positive().describe("Units the job needs (1 unit = 1 token, prompt + completion)"),
        model: z.string().optional().describe("Model filter, e.g. 'llama' or 'deepseek'"),
        maxLatencyMs: z.number().positive().optional(),
      },
      readOnly: true,
      run: async (need: { units: number; model?: string; maxLatencyMs?: number }) => {
        const offers = await api.offers();
        const budget = ledger.budgetStatus();
        const vouchers = api.address ? await api.vouchers().catch(() => []) : [];
        const covering = usableVoucher(vouchers, offers, need);
        return {
          coveredByVoucher: covering ? strip(covering) : null,
          quotes: quote(offers, need, cfg, budget.remainingToday).map((q) => ({ ...q, offer: strip(q.offer) })),
          budget,
        };
      },
    },
    {
      name: "buy_compute_pass",
      description:
        "Buy one pass of an offer via x402 (BSC Testnet, U token). Spends funds from the agent wallet; refused when it breaks the per-purchase or daily budget or allowlists. Only buy when no existing voucher covers the job.",
      shape: { offerId: z.string().describe("Offer id from list_compute_offers") },
      readOnly: false,
      run: async ({ offerId }: { offerId: string }) => {
        const r = await api.buy(offerId);
        return { ...r, voucher: strip(r.voucher) };
      },
    },
    {
      name: "get_voucher_balance",
      description: "List vouchers of the agent wallet (or of `owner`) with remaining units, status and expiry.",
      shape: {
        owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
        voucherId: z.string().optional(),
      },
      readOnly: true,
      run: async ({ owner, voucherId }: { owner?: string; voucherId?: string }) => {
        const vouchers = (await api.vouchers(owner)).map(strip);
        return voucherId ? (vouchers.find((v) => v.id === voucherId) ?? { error: `voucher not found: ${voucherId}` }) : vouchers;
      },
    },
    {
      name: "redeem_inference",
      description:
        "Run a prompt against a voucher. maxUnits caps prompt + completion tokens; the wallet signs a single-use redemption locally and only real usage is billed.",
      shape: {
        voucherId: z.string(),
        prompt: z.string().min(1).max(16000),
        maxUnits: z.number().int().min(1).max(32000).default(1024),
      },
      readOnly: false,
      run: async ({ voucherId, prompt, maxUnits }: { voucherId: string; prompt: string; maxUnits?: number }) =>
        api.redeem(voucherId, prompt, maxUnits ?? 1024),
    },
    {
      name: "get_execution_receipt",
      description:
        "Receipt for a voucher: its purchase (amount, settlement tx) and every redemption (prompt hash, model, units), with a SHA-256 digest. Without voucherId, returns recent activity and budget.",
      shape: { voucherId: z.string().optional() },
      readOnly: true,
      run: async ({ voucherId }: { voucherId?: string }) =>
        voucherId ? ledger.receipt(voucherId) : { recent: ledger.recent(), budget: ledger.budgetStatus(), wallet: api.address ?? null },
    },
  ];
}

/** Validate model-supplied arguments, run the tool, and return a JSON string (errors included). */
export async function runTool(tool: ToolDef, rawArgs: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const args = z.object(tool.shape).parse(rawArgs ?? {});
    return { ok: true, text: JSON.stringify(await tool.run(args)) };
  } catch (e) {
    return { ok: false, text: JSON.stringify({ error: `${(e as Error).name}: ${(e as Error).message}` }) };
  }
}

/** OpenAI / OpenRouter `tools` array. */
export function toOpenAiTools(tools: ToolDef[]) {
  return tools.map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(z.object(t.shape), { io: "input" }) as Record<string, unknown>;
    return { type: "function" as const, function: { name: t.name, description: t.description, parameters } };
  });
}
