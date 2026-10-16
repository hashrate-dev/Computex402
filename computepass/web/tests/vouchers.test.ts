import assert from "node:assert/strict";
import { it } from "node:test";
import { handleListVouchers } from "../lib/server/vouchers";
import { createTestDb } from "./d1-sqlite";

const NOW = 1_800_000_000;
const OWNER = "0x1111111111111111111111111111111111111111";

it("derives expired and spent status instead of reporting them as active", async () => {
  const db = createTestDb();
  const insert = db.raw.prepare(
    `INSERT INTO vouchers (id, offer_id, owner_address, total_units, remaining_units, payment_nonce, payment_tx, status, issued_at, expires_at)
     VALUES (?, 'llama-70b-burst', ?, 100, ?, ?, ?, 'active', ?, ?)`,
  );
  insert.run("a", OWNER, 100, "n1", "t1", NOW - 3, NOW + 10);
  insert.run("b", OWNER, 100, "n2", "t2", NOW - 2, NOW - 1);
  insert.run("c", OWNER, 0, "n3", "t3", NOW - 1, NOW + 10);
  const res = await handleListVouchers(new Request(`https://x.test/api/vouchers?owner=${OWNER}`), {
    db,
    env: {},
    fetch,
    now: () => NOW,
  });
  const { vouchers } = (await res.json()) as { vouchers: Array<{ id: string; status: string }> };
  assert.deepEqual(
    Object.fromEntries(vouchers.map((v) => [v.id, v.status])),
    { a: "active", b: "expired", c: "spent" },
  );
});
