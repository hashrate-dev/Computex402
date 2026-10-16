import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const vouchers = sqliteTable(
  "vouchers",
  {
    id: text("id").primaryKey(),
    offerId: text("offer_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    totalUnits: integer("total_units").notNull(),
    remainingUnits: integer("remaining_units").notNull(),
    paymentNonce: text("payment_nonce").notNull(),
    paymentTx: text("payment_tx").notNull(),
    contractTokenId: text("contract_token_id"),
    status: text("status").notNull().default("active"),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("vouchers_payment_nonce_unique").on(table.paymentNonce),
    uniqueIndex("vouchers_payment_tx_unique").on(table.paymentTx),
  ],
);

/**
 * One row per EIP-3009 authorization seen. The nonce is claimed here before
 * the facilitator is called; status: pending | settled | failed.
 */
export const payments = sqliteTable(
  "payments",
  {
    nonce: text("nonce").primaryKey(),
    voucherId: text("voucher_id").notNull(),
    offerId: text("offer_id").notNull(),
    payer: text("payer").notNull(),
    amountAtomic: text("amount_atomic").notNull(),
    status: text("status").notNull(),
    paymentTx: text("payment_tx"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** EIP-3009 validBefore; past it an unused authorization can never settle. */
    validBefore: integer("valid_before"),
  },
  (table) => [uniqueIndex("payments_voucher_id_unique").on(table.voucherId)],
);

/**
 * status: pending | completed | failed | rejected. `nonce` is unique so a
 * signed redemption can be used once; rows written before protocol v2 have
 * a NULL nonce.
 */
export const redemptions = sqliteTable(
  "redemptions",
  {
    id: text("id").primaryKey(),
    voucherId: text("voucher_id")
      .notNull()
      .references(() => vouchers.id),
    nonce: text("nonce"),
    units: integer("units").notNull(),
    reservedUnits: integer("reserved_units").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    promptHash: text("prompt_hash").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("redemptions_nonce_unique").on(table.nonce)],
);

/**
 * Control plane for the buyer agent that runs on the owner's machine
 * (../agent/src/daemon.ts). One row, id 'default'. Caps here can only
 * tighten the agent's local caps, never loosen them. NULL = no remote cap.
 */
export const agentSettings = sqliteTable("agent_settings", {
  id: text("id").primaryKey(),
  paused: integer("paused").notNull().default(1),
  maxPerPurchaseAtomic: text("max_per_purchase_atomic"),
  maxPerDayAtomic: text("max_per_day_atomic"),
  maxUnitsPerRedeem: integer("max_units_per_redeem"),
  /** Comma-separated offer ids; NULL = any offer the local config allows. */
  allowedOffers: text("allowed_offers"),
  updatedAt: integer("updated_at").notNull(),
});

/** Last check-in of the agent: what it reports about itself. */
export const agentHeartbeats = sqliteTable("agent_heartbeats", {
  agentId: text("agent_id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  balanceAtomic: text("balance_atomic"),
  /** JSON of the agent's local hard caps. */
  localBudget: text("local_budget"),
  version: text("version"),
  lastError: text("last_error"),
  seenAt: integer("seen_at").notNull(),
});

/** Work queue. status: queued | running | done | failed | cancelled. */
export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    prompt: text("prompt").notNull(),
    units: integer("units").notNull(),
    model: text("model"),
    status: text("status").notNull(),
    voucherId: text("voucher_id"),
    unitsUsed: integer("units_used"),
    paidAtomic: text("paid_atomic"),
    resultText: text("result_text"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [index("agent_tasks_status_created").on(table.status, table.createdAt)],
);

/** What the agent decided and why (bought, reused, refused by a cap...). */
export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    taskId: text("task_id"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("agent_events_created").on(table.createdAt)],
);
