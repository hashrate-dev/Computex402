/**
 * Compute work hook — the seller's product.
 *
 * A paid request carries a JSON compute spec as its prompt, e.g.
 *   {"task":"primes","n":1000000}
 * The spec is validated against a fixed menu of CPU tasks with hard caps,
 * then run in a worker thread with a memory limit and a wall-clock timeout
 * (the worker is terminated when it runs over). No user code is executed:
 * arbitrary scripts need a real sandbox (container / microVM) first.
 *
 * Runs only after the x402 payment gate (or the free passthrough when the
 * price is 0); signing and settlement stay in fixed runtime code.
 */

import { Worker } from "node:worker_threads";
import type { RunWork } from "./sellerCore.js";

const TIMEOUT_MS = Number(process.env.COMPUTE_TIMEOUT_MS || 20_000);
const MAX_HEAP_MB = Number(process.env.COMPUTE_MAX_HEAP_MB || 256);

/** The task menu: name → description + the cap on its size parameter. */
export const COMPUTE_TASKS = {
  primes: { param: "n", max: 50_000_000, doc: "count primes ≤ n (sieve)" },
  sha256_chain: { param: "rounds", max: 5_000_000, doc: "iterate sha256 over a seed" },
  matmul: { param: "size", max: 400, doc: "multiply two seeded size×size matrices, return checksum" },
  monte_carlo_pi: { param: "samples", max: 200_000_000, doc: "estimate π with seeded samples" },
} as const;

export type ComputeTask = keyof typeof COMPUTE_TASKS;

export interface ComputeSpec {
  task: ComputeTask;
  size: number;
  seed: string;
}

/** Parse and validate the first JSON object in the prompt. Throws on bad input. */
export function parseSpec(prompt: string): ComputeSpec {
  const start = prompt.indexOf("{");
  const end = prompt.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(usage("no JSON spec found"));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(prompt.slice(start, end + 1));
  } catch {
    throw new Error(usage("spec is not valid JSON"));
  }
  const task = String(raw.task ?? "") as ComputeTask;
  const def = COMPUTE_TASKS[task];
  if (!def) throw new Error(usage(`unknown task "${task}"`));
  const size = Number(raw[def.param]);
  if (!Number.isInteger(size) || size < 1 || size > def.max) {
    throw new Error(usage(`${def.param} must be an integer in 1..${def.max}`));
  }
  return { task, size, seed: String(raw.seed ?? "computex402") };
}

function usage(reason: string): string {
  const menu = Object.entries(COMPUTE_TASKS)
    .map(([k, v]) => `${k} {${v.param} ≤ ${v.max}}: ${v.doc}`)
    .join("; ");
  return `invalid compute spec: ${reason}. Send {"task": ..., <param>: ...}. Tasks: ${menu}`;
}

// The worker body is plain JS so it runs the same under tsx and compiled builds.
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
function rng(seed) {
  let h = 2166136261 >>> 0;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
}
const { task, size, seed } = workerData;
let result;
if (task === "primes") {
  const sieve = new Uint8Array(size + 1); let count = 0;
  for (let i = 2; i <= size; i++) {
    if (!sieve[i]) { count++; for (let j = i * i; j <= size; j += i) sieve[j] = 1; }
  }
  result = { primes: count };
} else if (task === "sha256_chain") {
  let d = Buffer.from(seed);
  for (let i = 0; i < size; i++) d = createHash("sha256").update(d).digest();
  result = { digest: d.toString("hex") };
} else if (task === "matmul") {
  const r = rng(seed), n = size;
  const a = Float64Array.from({ length: n * n }, r), b = Float64Array.from({ length: n * n }, r);
  const c = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
    const aik = a[i * n + k];
    for (let j = 0; j < n; j++) c[i * n + j] += aik * b[k * n + j];
  }
  let sum = 0; for (const v of c) sum += v;
  result = { checksum: sum };
} else if (task === "monte_carlo_pi") {
  const r = rng(seed); let inside = 0;
  for (let i = 0; i < size; i++) { const x = r(), y = r(); if (x * x + y * y <= 1) inside++; }
  result = { pi: (4 * inside) / size };
}
parentPort.postMessage(result);
`;

/** Run one validated spec in a resource-limited worker. */
export function runCompute(
  spec: ComputeSpec,
  abortSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: spec,
      resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB },
    });
    const stop = (err: Error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(err);
    };
    const timer = setTimeout(
      () => stop(new Error(`compute timed out after ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
    abortSignal?.addEventListener("abort", () => stop(new Error("compute aborted")));
    worker.once("message", (output) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve({
        task: spec.task,
        [COMPUTE_TASKS[spec.task].param]: spec.size,
        seed: spec.seed,
        output,
        cpu_ms: Math.round(performance.now() - started),
      });
    });
    worker.once("error", stop);
  });
}

/** The RunWork hook wired into both rails in unifiedMain.ts. */
export function buildComputeWork(): RunWork {
  return async (prompt, { abortSignal }) => {
    const spec = parseSpec(prompt);
    return JSON.stringify(await runCompute(spec, abortSignal));
  };
}
