import assert from "node:assert/strict";
import test from "node:test";
import { decideRecovery, resolveMemoryOrdinal } from "../../lib/server/output-saga";

test("memory ordinal replay resolves the original READY asset", () => {
  const assets = new Map([["winner", { id: "winner", ownerId: "owner", status: "READY" }]]);
  const rows = [{ assetId: "winner", ordinal: 0 }];
  assert.equal(resolveMemoryOrdinal(rows, assets, 0, "owner")?.id, "winner");
  assert.equal(resolveMemoryOrdinal(rows, assets, 1, "owner"), null);
});

test("recovery decisions distinguish valid, recent, stale, and tombstone rows", () => {
  assert.equal(decideRecovery("PENDING", true, 0, 600_000), "attach");
  assert.equal(decideRecovery("PENDING", false, 100, 600_000), "wait");
  assert.equal(decideRecovery("PENDING", false, 600_001, 600_000), "cleanup");
  assert.equal(decideRecovery("READY", false, 0, 600_000), "cleanup");
  assert.equal(decideRecovery("DELETED", false, 0, 600_000), "retry-tombstone");
});
