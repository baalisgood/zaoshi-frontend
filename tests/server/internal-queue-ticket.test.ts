import assert from "node:assert/strict";
import test from "node:test";

import {
  createInputTicket,
  createOutputTicket,
  assertInternalQueueTicketSecretIsIndependent,
  resolveInternalQueueTicketConfig,
  verifyInputTicket,
  verifyOutputTicket,
} from "../../lib/server/internal-queue-ticket";

const config = {
  audience: "zaoshi-test",
  secret: "ticket-secret-that-is-at-least-thirty-two-bytes-long",
  ttlSeconds: 120,
};
const fence = {
  itemId: "qitem-ticket-1",
  leaseToken: "lease-token-ticket-1",
  leaseGeneration: 2,
};

test("input tickets are scoped to a single fence, asset, role and expiry", async () => {
  const token = await createInputTicket({
    config,
    fence,
    attemptId: "attempt-ticket-1",
    assetId: "asset-ticket-1",
    role: "source",
    index: 0,
    mimeType: "image/png",
    byteSize: 68,
    sha256: "a".repeat(64),
    leaseExpiresAt: 1_100,
    nowSeconds: 1_000,
    jti: "ticket-jti-input",
  });
  const claims = await verifyInputTicket(token, config, fence, 1_050);
  assert.equal(claims.assetId, "asset-ticket-1");
  assert.equal(claims.role, "source");
  assert.equal(claims.exp, 1_120);

  await assert.rejects(
    verifyInputTicket(token, config, { ...fence, leaseGeneration: 3 }, 1_050),
    hasCode("INTERNAL_TICKET_INVALID"),
  );
  await assert.rejects(
    verifyInputTicket(`${token.slice(0, -1)}x`, config, fence, 1_050),
    hasCode("INTERNAL_TICKET_INVALID"),
  );
  assert.equal(
    (await verifyInputTicket(token, config, fence, 1_101)).assetId,
    "asset-ticket-1",
  );
  await assert.rejects(
    verifyInputTicket(token, config, fence, 1_121),
    hasCode("INTERNAL_TICKET_INVALID"),
  );
  await assert.rejects(
    createInputTicket({
      config,
      fence,
      attemptId: "attempt-ticket-stale",
      assetId: "asset-ticket-stale",
      role: "source",
      index: 0,
      mimeType: "image/png",
      byteSize: 68,
      sha256: "c".repeat(64),
      leaseExpiresAt: 999,
      nowSeconds: 1_000,
    }),
    hasCode("QUEUE_FENCE_STALE"),
  );
});

test("output tickets cannot be replayed as input tickets", async () => {
  const token = await createOutputTicket({
    config,
    fence,
    attemptId: "attempt-ticket-2",
    commitId: "ocommit-ticket-2",
    mimeType: "image/png",
    byteSize: 68,
    sha256: "b".repeat(64),
    leaseExpiresAt: 1_010,
    nowSeconds: 1_000,
    jti: "ticket-jti-output",
  });
  assert.equal(
    (await verifyOutputTicket(token, config, fence, 1_010)).commitId,
    "ocommit-ticket-2",
  );
  await assert.rejects(
    verifyInputTicket(token, config, fence, 1_010),
    hasCode("INTERNAL_TICKET_INVALID"),
  );
  assert.equal(
    (await verifyOutputTicket(token, config, fence, 1_060)).commitId,
    "ocommit-ticket-2",
  );
});

test("ticket configuration requires an independent strong secret", () => {
  assert.throws(
    () =>
      resolveInternalQueueTicketConfig({
        GENERATION_INTERNAL_AUDIENCE: "zaoshi-test",
        GENERATION_INTERNAL_TICKET_SECRET: "short",
      }),
    hasCode("INTERNAL_QUEUE_TICKET_MISCONFIGURED"),
  );
  assert.equal(
    resolveInternalQueueTicketConfig({
      GENERATION_INTERNAL_AUDIENCE: "zaoshi-test",
      GENERATION_INTERNAL_TICKET_SECRET: config.secret,
      GENERATION_INTERNAL_TICKET_TTL_SECONDS: "300",
    }).ttlSeconds,
    300,
  );
  assert.throws(
    () =>
      resolveInternalQueueTicketConfig({
        GENERATION_INTERNAL_AUDIENCE: "zaoshi-test",
        GENERATION_INTERNAL_TICKET_SECRET: config.secret,
        GENERATION_INTERNAL_TICKET_TTL_SECONDS: "60",
      }),
    hasCode("INTERNAL_QUEUE_TICKET_MISCONFIGURED"),
  );
  assert.throws(
    () =>
      assertInternalQueueTicketSecretIsIndependent(config, [config.secret]),
    hasCode("INTERNAL_QUEUE_SECRET_REUSE"),
  );
  assert.doesNotThrow(() =>
    assertInternalQueueTicketSecretIsIndependent(config, [
      "machine-secret-that-is-distinct-and-long-enough",
    ]),
  );
});

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
