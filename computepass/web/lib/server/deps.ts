import { env } from "cloudflare:workers";
import type { Deps, SqlDb } from "./types";

/** Production wiring for route handlers. */
export function workerDeps(): Deps {
  return {
    db: env.DB as unknown as SqlDb | undefined,
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => Math.floor(Date.now() / 1000),
  };
}
