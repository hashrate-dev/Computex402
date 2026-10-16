/**
 * The subset of Cloudflare D1 the handlers use. Kept structural so tests can
 * run the same handlers against node:sqlite (see tests/d1-sqlite.ts).
 */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}

export interface ServerEnv {
  MERCHANT_ADDRESS?: string;
  FACILITATOR_URL?: string;
  INFERENCE_API_URL?: string;
  INFERENCE_API_KEY?: string;
  INFERENCE_MODEL_MAP?: string;
  /** Host the redemption signature must name; defaults to the request host. */
  PUBLIC_HOST?: string;
  VOUCHER_CONTRACT_ADDRESS?: string;
  /** JSON-RPC used to reconcile payments; defaults to a public BSC testnet node. */
  BSC_RPC_URL?: string;
  /** Bearer token for POST /api/admin/maintenance; the endpoint is off without it. */
  ADMIN_TOKEN?: string;
}

export interface Deps {
  db: SqlDb | undefined;
  env: ServerEnv;
  fetch: typeof fetch;
  /** Unix seconds. */
  now: () => number;
  /** Override for tests; defaults to crypto.randomUUID. */
  uuid?: () => string;
}
