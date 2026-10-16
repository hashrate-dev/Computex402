import { buildComputeWork } from "../src/compute.js";
const w = buildComputeWork();
for (const p of ['{"task":"primes","n":10000000}','{"task":"sha256_chain","rounds":1000000}','{"task":"matmul","size":300}','{"task":"monte_carlo_pi","samples":50000000}','{"task":"matmul","size":9999}','rm -rf /']) {
  try { console.log(await w(p, { sessionId: "t" })); } catch (e) { console.log("ERR", (e as Error).message.slice(0,120)); }
}
