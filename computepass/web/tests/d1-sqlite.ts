import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlStatement } from "../lib/server/types";

/** D1-shaped adapter over node:sqlite, loaded with the real migrations. */
class Statement implements SqlStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values);
  }
  private args() {
    return this.params.map((v) => (v === undefined ? null : v)) as never[];
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[] };
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    const result = this.db.prepare(this.sql).run(...this.args());
    return { meta: { changes: Number(result.changes) } };
  }
}

export function createTestDb(): SqlDb & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const dir = join(import.meta.dirname, "..", "drizzle");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => (s as Statement).runSync());
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
