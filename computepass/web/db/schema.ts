import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
