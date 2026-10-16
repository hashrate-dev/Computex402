/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures read loosely-typed JSON */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters } from "viem";
import { STALE_TASK_SECONDS, handleAdminAgent, handleAgentSync } from "../lib/server/agent";
import type { Deps } from "../lib/server/types";
import { createTestDb } from "./d1-sqlite";

const T0 = 1_800_000_000;
const ADMIN = "a".repeat(40);
const AGENT = "g".repeat(40);
const body = async (response: Promise<Response>): Promise<any> => (await response).json();
const WALLET = "0x4eBcd26E21f2588188b9BB424c8FFe5C3CCA698B";

function setup(balance: bigint | null = null) {
  const db = createTestDb();
  let now = T0;
  const deps: Deps = {
    db,
    env: { ADMIN_TOKEN: ADMIN, AGENT_TOKEN: AGENT },
    now: () => now,
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (balance === null) throw new Error("rpc down");
      assert.equal(body.method, "eth_call");
      return Response.json({ jsonrpc: "2.0", id: 1, result: encodeAbiParameters([{ type: "uint256" }], [balance]) });
    }) as typeof fetch,
  };
  const admin = (body?: unknown, token = ADMIN) =>
    handleAdminAgent(
      new Request("https://x.test/api/admin/agent", {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
      deps,
    );
  const sync = (body: unknown, token = AGENT) =>
    handleAgentSync(
      new Request("https://x.test/api/agent/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      deps,
    );
  return { db, deps, admin, sync, advance: (s: number) => (now += s) };
}

describe("agent control plane", () => {
  it("is off without tokens and rejects the wrong token", async () => {
    const { deps, admin, sync } = setup();
    assert.equal((await admin(undefined, "nope")).status, 401);
    assert.equal((await sync({ address: WALLET }, ADMIN)).status, 401, "the admin token is not an agent token");
    assert.equal((await sync({ address: WALLET }, "x")).status, 401);
    const off = { ...deps, env: {} };
    assert.equal((await handleAgentSync(new Request("https://x.test/", { method: "POST" }), off)).status, 404);
    assert.equal((await handleAdminAgent(new Request("https://x.test/"), off)).status, 404);
  });

  it("starts paused and hands out no task until the owner turns it on", async () => {
    const { admin, sync } = setup();
    assert.equal((await admin({ action: "task", prompt: "hola", units: 256 })).status, 201);
    let res = await body(sync({ address: WALLET }));
    assert.equal(res.settings.paused, true);
    assert.deepEqual(res.tasks, []);
    await admin({ action: "settings", paused: false });
    res = await body(sync({ address: WALLET }));
    assert.equal(res.tasks.length, 1);
    assert.equal(res.tasks[0].prompt, "hola");
    res = await body(sync({ address: WALLET }));
    assert.deepEqual(res.tasks, [], "a claimed task is not handed out twice");
  });

  it("records results, events and wallet state for the panel", async () => {
    const { db, admin, sync } = setup(7n * 10n ** 16n);
    await admin({ action: "settings", paused: false, maxPerPurchase: "0,03", maxPerDay: "0.1", allowedOffers: ["llama-70b-burst"] });
    await admin({ action: "task", prompt: "resumí x402", units: 300 });
    const { tasks } = await body(sync({ address: WALLET, balanceAtomic: "1" }));
    db.raw
      .prepare(
        `INSERT INTO payments (nonce, voucher_id, offer_id, payer, amount_atomic, status, payment_tx, created_at, updated_at)
         VALUES ('0x01', 'v1', 'llama-70b-burst', ?, '25000000000000000', 'settled', '0xtx', ?, ?)`,
      )
      .run(WALLET.toLowerCase(), T0, T0);
    await sync({
      address: WALLET,
      results: [{ taskId: tasks[0].id, status: "done", voucherId: "v1", unitsUsed: 120, paidAtomic: "25000000000000000", resultText: "ok" }],
      events: [{ kind: "purchase", message: "Compré llama-70b-burst", taskId: tasks[0].id }],
    });
    const view = await body(admin());
    assert.equal(view.agent.online, true);
    assert.equal(view.settings.maxPerPurchaseAtomic, "30000000000000000");
    assert.deepEqual(view.settings.allowedOffers, ["llama-70b-burst"]);
    assert.equal(view.wallet.balanceAtomic, "70000000000000000");
    assert.equal(view.wallet.balanceSource, "chain");
    assert.equal(view.wallet.spentTodayAtomic, "25000000000000000");
    assert.equal(view.tasks[0].status, "done");
    assert.equal(view.tasks[0].resultText, "ok");
    assert.ok(view.events.some((e: { kind: string }) => e.kind === "purchase"));
  });

  it("falls back to the balance the agent reported when the chain is unreachable", async () => {
    const { admin, sync } = setup(null);
    await sync({ address: WALLET, balanceAtomic: "5" });
    const view = await body(admin());
    assert.equal(view.wallet.balanceAtomic, "5");
    assert.equal(view.wallet.balanceSource, "agent");
  });

  it("validates admin input", async () => {
    const { admin } = setup();
    assert.equal((await admin({ action: "settings", maxPerDay: "mucho" })).status, 400);
    assert.equal((await admin({ action: "settings", allowedOffers: ["inventada"] })).status, 400);
    assert.equal((await admin({ action: "task", prompt: "" })).status, 400);
    assert.equal((await admin({ action: "task", prompt: "x", units: 0 })).status, 400);
    assert.equal((await admin({ action: "otra" })).status, 400);
  });

  it("cancels queued tasks only, and closes lost running tasks without retrying them", async () => {
    const { admin, sync, advance } = setup();
    await admin({ action: "settings", paused: false });
    const a = (await body(admin({ action: "task", prompt: "a" }))).taskId;
    advance(1);
    const b = (await body(admin({ action: "task", prompt: "b" }))).taskId;
    const claimed = (await body(sync({ address: WALLET }))).tasks[0].id;
    assert.equal(claimed, a);
    assert.equal((await admin({ action: "cancel", taskId: a })).status, 409, "running tasks cannot be cancelled");
    assert.equal((await admin({ action: "cancel", taskId: b })).status, 200);
    advance(STALE_TASK_SECONDS + 1);
    const res = await body(sync({ address: WALLET }));
    assert.deepEqual(res.tasks, []);
    const view = await body(admin());
    const status = Object.fromEntries(view.tasks.map((t: { id: string; status: string }) => [t.id, t.status]));
    assert.deepEqual(status, { [a]: "failed", [b]: "cancelled" });
  });
});
