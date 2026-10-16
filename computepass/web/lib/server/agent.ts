import { decodeFunctionResult, encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Hex } from "viem";
import { U_DECIMALS, U_TOKEN, offers } from "../catalog";
import { jsonError, readJsonObject } from "../wire";
import { rpc, sameSecret } from "./maintenance";
import type { Deps, SqlDb } from "./types";

/**
 * Control plane for the buyer agent that runs on the owner's machine
 * (computepass/agent/src/daemon.ts):
 *
 * - POST /api/agent/sync (AGENT_TOKEN): the agent checks in, reports task
 *   results and events, and gets back its settings and the next queued task.
 * - GET/POST /api/admin/agent (ADMIN_TOKEN): the /admin page reads the whole
 *   picture and changes settings or the task queue.
 *
 * The site never holds the buyer key. Caps set here only tighten the agent's
 * local caps (the agent applies the minimum of both), so someone who gets
 * into this panel can stop the agent or make it spend less, never more.
 */

export const AGENT_ID = "default";
/** An agent that has not checked in for this long shows as offline. */
export const AGENT_ONLINE_SECONDS = 120;
/** A task claimed this long ago without a result is closed as failed, never retried (it may have paid). */
export const STALE_TASK_SECONDS = 30 * 60;
const MAX_PROMPT = 16_000;
const MAX_TASK_UNITS = 32_000;
const MAX_EVENTS_PER_SYNC = 20;

export interface AgentSettings {
  paused: boolean;
  maxPerPurchaseAtomic: string | null;
  maxPerDayAtomic: string | null;
  maxUnitsPerRedeem: number | null;
  allowedOffers: string[] | null;
  updatedAt: number | null;
}

type SettingsRow = {
  paused: number;
  maxPerPurchaseAtomic: string | null;
  maxPerDayAtomic: string | null;
  maxUnitsPerRedeem: number | null;
  allowedOffers: string | null;
  updatedAt: number;
};

const noStore = { "Cache-Control": "no-store" };

function bearer(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

/** 404 when the token is not configured (the feature is off), 401 on a wrong token. */
function authorize(request: Request, token: string | undefined): Response | null {
  if (!token || token.length < 32) return jsonError("not_found", 404);
  if (!sameSecret(bearer(request), token)) return jsonError("unauthorized", 401);
  return null;
}

export async function readSettings(db: SqlDb): Promise<AgentSettings> {
  const row = await db
    .prepare(
      `SELECT paused, max_per_purchase_atomic AS maxPerPurchaseAtomic, max_per_day_atomic AS maxPerDayAtomic,
        max_units_per_redeem AS maxUnitsPerRedeem, allowed_offers AS allowedOffers, updated_at AS updatedAt
       FROM agent_settings WHERE id = ?`,
    )
    .bind(AGENT_ID)
    .first<SettingsRow>();
  // No row yet: the agent starts paused until the owner turns it on.
  if (!row) return { paused: true, maxPerPurchaseAtomic: null, maxPerDayAtomic: null, maxUnitsPerRedeem: null, allowedOffers: null, updatedAt: null };
  return {
    paused: row.paused !== 0,
    maxPerPurchaseAtomic: row.maxPerPurchaseAtomic,
    maxPerDayAtomic: row.maxPerDayAtomic,
    maxUnitsPerRedeem: row.maxUnitsPerRedeem,
    allowedOffers: row.allowedOffers ? row.allowedOffers.split(",").filter(Boolean) : null,
    updatedAt: row.updatedAt,
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

// ---------------------------------------------------------------- agent side

/** POST /api/agent/sync with `Authorization: Bearer $AGENT_TOKEN`. */
export async function handleAgentSync(request: Request, deps: Deps): Promise<Response> {
  const denied = authorize(request, deps.env.AGENT_TOKEN);
  if (denied) return denied;
  const db = deps.db;
  if (!db) return jsonError("database_unavailable", 503);
  const body = await readJsonObject(request);
  if (!body) return jsonError("invalid_json", 400);
  const address = typeof body.address === "string" && isAddress(body.address) ? getAddress(body.address).toLowerCase() : null;
  if (!address) return jsonError("wallet_invalid", 400);
  const now = deps.now();
  const balance = typeof body.balanceAtomic === "string" && /^\d{1,78}$/.test(body.balanceAtomic) ? body.balanceAtomic : null;

  await db
    .prepare(
      `INSERT INTO agent_heartbeats (agent_id, wallet_address, balance_atomic, local_budget, version, last_error, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET wallet_address = excluded.wallet_address,
         balance_atomic = COALESCE(excluded.balance_atomic, agent_heartbeats.balance_atomic),
         local_budget = excluded.local_budget, version = excluded.version, last_error = excluded.last_error, seen_at = excluded.seen_at`,
    )
    .bind(
      AGENT_ID,
      address,
      balance,
      body.localBudget && typeof body.localBudget === "object" ? JSON.stringify(body.localBudget).slice(0, 2000) : null,
      str(body.version, 40),
      str(body.error, 500),
      now,
    )
    .run();

  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_SYNC) : [];
  for (const e of events as Array<Record<string, unknown>>) {
    const message = str(e?.message, 500);
    if (!message) continue;
    await db
      .prepare("INSERT INTO agent_events (id, kind, message, task_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), str(e.kind, 40) ?? "info", message, str(e.taskId, 64), now)
      .run();
  }

  const results = Array.isArray(body.results) ? body.results.slice(0, 20) : [];
  for (const r of results as Array<Record<string, unknown>>) {
    const id = str(r?.taskId, 64);
    const status = r?.status === "done" || r?.status === "failed" ? r.status : null;
    if (!id || !status) continue;
    const paid = typeof r.paidAtomic === "string" && /^\d{1,78}$/.test(r.paidAtomic) ? r.paidAtomic : null;
    await db
      .prepare(
        `UPDATE agent_tasks SET status = ?, voucher_id = ?, units_used = ?, paid_atomic = ?, result_text = ?, error = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .bind(status, str(r.voucherId, 64), int(r.unitsUsed), paid, str(r.resultText, 20_000), str(r.error, 500), now, id)
      .run();
  }

  // A claimed task with no result for too long: close it, never hand it out again.
  await db
    .prepare(
      "UPDATE agent_tasks SET status = 'failed', error = 'agent_lost_task', finished_at = ? WHERE status = 'running' AND started_at < ?",
    )
    .bind(now, now - STALE_TASK_SECONDS)
    .run();

  const settings = await readSettings(db);
  const tasks: Array<{ id: string; prompt: string; units: number; model: string | null }> = [];
  if (!settings.paused && body.claim !== false) {
    const next = await db
      .prepare("SELECT id, prompt, units, model FROM agent_tasks WHERE status = 'queued' ORDER BY created_at, id LIMIT 1")
      .first<{ id: string; prompt: string; units: number; model: string | null }>();
    if (next) {
      const claimed = await db
        .prepare("UPDATE agent_tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
        .bind(now, next.id)
        .run();
      if (claimed.meta.changes) tasks.push(next);
    }
  }
  return Response.json({ settings, tasks, serverTime: now }, { headers: noStore });
}

// ---------------------------------------------------------------- admin side

async function liveBalance(deps: Deps, address: string): Promise<string | null> {
  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(address)] });
    const result = await rpc<Hex>(deps, "eth_call", [{ to: U_TOKEN, data }, "latest"]);
    return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result }).toString();
  } catch {
    return null;
  }
}

const startOfUtcDay = (now: number) => now - (now % 86_400);

export async function agentOverview(deps: Deps) {
  const db = deps.db!;
  const now = deps.now();
  const settings = await readSettings(db);
  const heartbeat = await db
    .prepare(
      `SELECT wallet_address AS walletAddress, balance_atomic AS balanceAtomic, local_budget AS localBudget,
        version, last_error AS lastError, seen_at AS seenAt
       FROM agent_heartbeats WHERE agent_id = ?`,
    )
    .bind(AGENT_ID)
    .first<{ walletAddress: string; balanceAtomic: string | null; localBudget: string | null; version: string | null; lastError: string | null; seenAt: number }>();

  const tasks = (
    await db
      .prepare(
        `SELECT id, prompt, units, model, status, voucher_id AS voucherId, units_used AS unitsUsed, paid_atomic AS paidAtomic,
          result_text AS resultText, error, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
         FROM agent_tasks ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .all()
  ).results;
  const events = (
    await db
      .prepare("SELECT id, kind, message, task_id AS taskId, created_at AS createdAt FROM agent_events ORDER BY created_at DESC, rowid DESC LIMIT 50")
      .all()
  ).results;

  let wallet = null;
  if (heartbeat) {
    const address = heartbeat.walletAddress;
    const live = await liveBalance(deps, address);
    const vouchers = (
      await db
        .prepare(
          `SELECT id, offer_id AS offerId, total_units AS totalUnits, remaining_units AS remainingUnits, payment_tx AS paymentTx,
            CASE WHEN status <> 'active' THEN status WHEN expires_at <= ? THEN 'expired'
                 WHEN remaining_units <= 0 THEN 'spent' ELSE 'active' END AS status,
            issued_at AS issuedAt, expires_at AS expiresAt
           FROM vouchers WHERE owner_address = ? ORDER BY issued_at DESC LIMIT 50`,
        )
        .bind(now, address)
        .all()
    ).results;
    const payments = (
      await db
        .prepare(
          `SELECT nonce, voucher_id AS voucherId, offer_id AS offerId, amount_atomic AS amountAtomic, status,
            payment_tx AS paymentTx, error, created_at AS createdAt
           FROM payments WHERE payer = ? ORDER BY created_at DESC LIMIT 50`,
        )
        .bind(address)
        .all<{ amountAtomic: string; status: string; createdAt: number }>()
    ).results;
    const redemptions = (
      await db
        .prepare(
          `SELECT r.id, r.voucher_id AS voucherId, r.model, r.status, r.units, r.prompt_tokens AS promptTokens,
            r.completion_tokens AS completionTokens, r.created_at AS createdAt
           FROM redemptions r JOIN vouchers v ON v.id = r.voucher_id
           WHERE v.owner_address = ? ORDER BY r.created_at DESC LIMIT 50`,
        )
        .bind(address)
        .all<{ status: string; units: number }>()
    ).results;
    const usage = await db
      .prepare(
        `SELECT COALESCE(SUM(r.units), 0) AS units, COUNT(*) AS count
         FROM redemptions r JOIN vouchers v ON v.id = r.voucher_id
         WHERE v.owner_address = ? AND r.status = 'completed'`,
      )
      .bind(address)
      .first<{ units: number; count: number }>();
    const dayStart = startOfUtcDay(now);
    const settled = payments.filter((p) => p.status === "settled");
    const sum = (rows: typeof settled) => rows.reduce((s, p) => s + BigInt(p.amountAtomic), 0n).toString();
    wallet = {
      address,
      balanceAtomic: live ?? heartbeat.balanceAtomic,
      balanceSource: live ? "chain" : heartbeat.balanceAtomic ? "agent" : null,
      vouchers,
      payments,
      redemptions,
      spentTodayAtomic: sum(settled.filter((p) => p.createdAt >= dayStart)),
      spentTotalAtomic: sum(settled),
      unitsUsedTotal: usage?.units ?? 0,
      redemptionsTotal: usage?.count ?? 0,
    };
  }

  return {
    settings,
    agent: heartbeat
      ? {
          online: now - heartbeat.seenAt <= AGENT_ONLINE_SECONDS,
          seenAt: heartbeat.seenAt,
          version: heartbeat.version,
          lastError: heartbeat.lastError,
          localBudget: heartbeat.localBudget ? JSON.parse(heartbeat.localBudget) : null,
        }
      : null,
    wallet,
    tasks,
    events,
    offers: offers.map((o) => ({ id: o.id, model: o.model, units: o.units, priceAtomic: o.priceAtomic })),
    decimals: U_DECIMALS,
    serverTime: now,
  };
}

/** Decimal U ("0.05") -> atomic string; "" or null clears the cap. Throws on garbage. */
function capAtomic(v: unknown): string | null {
  if (v === null || v === "" || v === undefined) return null;
  const s = String(v).trim().replace(",", ".");
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error("cap_invalid");
  return parseUnits(s, U_DECIMALS).toString();
}

async function updateSettings(deps: Deps, body: Record<string, unknown>) {
  const db = deps.db!;
  const current = await readSettings(db);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  let allowed = current.allowedOffers;
  if (has("allowedOffers")) {
    const list = Array.isArray(body.allowedOffers) ? body.allowedOffers.map(String) : null;
    if (list && list.some((id) => !offers.some((o) => o.id === id))) throw new Error("offer_unknown");
    allowed = list && list.length ? list : null;
  }
  let units = current.maxUnitsPerRedeem;
  if (has("maxUnitsPerRedeem")) {
    units = body.maxUnitsPerRedeem === null || body.maxUnitsPerRedeem === "" ? null : Number(body.maxUnitsPerRedeem);
    if (units !== null && (!Number.isInteger(units) || units < 1 || units > MAX_TASK_UNITS)) throw new Error("units_invalid");
  }
  const next = {
    paused: has("paused") ? Boolean(body.paused) : current.paused,
    maxPerPurchaseAtomic: has("maxPerPurchase") ? capAtomic(body.maxPerPurchase) : current.maxPerPurchaseAtomic,
    maxPerDayAtomic: has("maxPerDay") ? capAtomic(body.maxPerDay) : current.maxPerDayAtomic,
    maxUnitsPerRedeem: units,
    allowedOffers: allowed,
  };
  await db
    .prepare(
      `INSERT INTO agent_settings (id, paused, max_per_purchase_atomic, max_per_day_atomic, max_units_per_redeem, allowed_offers, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, max_per_purchase_atomic = excluded.max_per_purchase_atomic,
         max_per_day_atomic = excluded.max_per_day_atomic, max_units_per_redeem = excluded.max_units_per_redeem,
         allowed_offers = excluded.allowed_offers, updated_at = excluded.updated_at`,
    )
    .bind(AGENT_ID, next.paused ? 1 : 0, next.maxPerPurchaseAtomic, next.maxPerDayAtomic, next.maxUnitsPerRedeem, next.allowedOffers?.join(",") ?? null, deps.now())
    .run();
  await db
    .prepare("INSERT INTO agent_events (id, kind, message, task_id, created_at) VALUES (?, 'admin', ?, NULL, ?)")
    .bind(crypto.randomUUID(), next.paused === current.paused ? "Topes actualizados desde el panel" : next.paused ? "Agente pausado desde el panel" : "Agente activado desde el panel", deps.now())
    .run();
}

async function enqueueTask(deps: Deps, body: Record<string, unknown>) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT) throw new Error("prompt_invalid");
  const units = Number(body.units ?? 512);
  if (!Number.isInteger(units) || units < 1 || units > MAX_TASK_UNITS) throw new Error("units_invalid");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 80) : null;
  const id = (deps.uuid ?? (() => crypto.randomUUID()))();
  await deps.db!
    .prepare("INSERT INTO agent_tasks (id, prompt, units, model, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
    .bind(id, prompt, units, model, deps.now())
    .run();
  return id;
}

/** GET (overview) and POST {action: settings|task|cancel} on /api/admin/agent with `Authorization: Bearer $ADMIN_TOKEN`. */
export async function handleAdminAgent(request: Request, deps: Deps): Promise<Response> {
  const denied = authorize(request, deps.env.ADMIN_TOKEN);
  if (denied) return denied;
  if (!deps.db) return jsonError("database_unavailable", 503);
  if (request.method === "GET") return Response.json(await agentOverview(deps), { headers: noStore });
  if (request.method !== "POST") return jsonError("method_not_allowed", 405);
  const body = await readJsonObject(request);
  if (!body) return jsonError("invalid_json", 400);
  try {
    if (body.action === "settings") {
      await updateSettings(deps, body);
      return Response.json({ settings: await readSettings(deps.db) }, { headers: noStore });
    }
    if (body.action === "task") return Response.json({ taskId: await enqueueTask(deps, body) }, { status: 201, headers: noStore });
    if (body.action === "cancel") {
      const id = typeof body.taskId === "string" ? body.taskId : "";
      const r = await deps.db
        .prepare("UPDATE agent_tasks SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'")
        .bind(deps.now(), id)
        .run();
      return r.meta.changes ? Response.json({ cancelled: id }, { headers: noStore }) : jsonError("task_not_queued", 409);
    }
  } catch (error) {
    return jsonError((error as Error).message, 400);
  }
  return jsonError("action_unknown", 400);
}

/** Formats an atomic U amount for logs and the panel. */
export const formatU = (atomic: string | bigint) => formatUnits(BigInt(atomic), U_DECIMALS);
