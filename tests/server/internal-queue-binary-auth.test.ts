import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createSignedInternalQueueHeaders,
  readAuthenticatedInternalQueueBody,
} from "../../lib/server/internal-queue-auth";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

const AUTH = {
  enabled: true as const,
  audience: "zaoshi-binary-test",
  transport: "https" as const,
  keys: new Map([
    [
      "current",
      {
        secret: "binary-auth-secret-that-is-at-least-thirty-two-bytes",
        expiresAt: null,
      },
    ],
  ]),
};

test("binary queue authentication covers the raw body and content limit", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const d1 = new TestD1Database(database);
  const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const now = 1_800_000_000;
  const request = await signedRequest(body, "binary-nonce-123456789012", now);
  assert.deepEqual(
    await readAuthenticatedInternalQueueBody(
      request,
      d1,
      AUTH,
      { maxBytes: 8, contentTypes: ["image/png"] },
      now,
    ),
    body,
  );

  const tampered = await signedRequest(body, "binary-nonce-abcdefghijkl", now);
  await assert.rejects(
    readAuthenticatedInternalQueueBody(
      new Request(tampered, { body: Uint8Array.from([1, 2, 3, 4]).buffer }),
      d1,
      AUTH,
      { maxBytes: 8, contentTypes: ["image/png"] },
      now,
    ),
    hasCode("INTERNAL_AUTH_FAILED"),
  );

  await assert.rejects(
    readAuthenticatedInternalQueueBody(
      await signedRequest(body, "binary-nonce-limit-123456", now),
      d1,
      AUTH,
      { maxBytes: 3, contentTypes: ["image/png"] },
      now,
    ),
    hasCode("BODY_TOO_LARGE"),
  );
});

test("an invalid signature is rejected before the binary body is read", async () => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const d1 = new TestD1Database(database);
  const now = 1_800_000_000;
  const headers = await createSignedInternalQueueHeaders({
    keyId: "current",
    secret: "binary-auth-secret-that-is-at-least-thirty-two-bytes",
    audience: "zaoshi-binary-test",
    method: "POST",
    pathname: "/api/internal/generation/output",
    body: Uint8Array.from([1]),
    timestamp: now,
    nonce: "binary-invalid-signature-1234",
    contentType: "image/png",
  });
  headers.set(
    "x-zaoshi-signature",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  const request = new Request(
    "https://zaoshi.example/api/internal/generation/output",
    {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit,
  );
  assert.equal(request.bodyUsed, false);
  await assert.rejects(
    readAuthenticatedInternalQueueBody(
      request,
      d1,
      AUTH,
      { maxBytes: 8 * 1024 * 1024, contentTypes: ["image/png"] },
      now,
    ),
    hasCode("INTERNAL_AUTH_FAILED"),
  );
  assert.equal(request.bodyUsed, false);
  const nonceCount = database
    .prepare("SELECT COUNT(*) AS count FROM generation_internal_nonces")
    .get() as { count: number };
  assert.equal(nonceCount.count, 0);
  void pulls;
});

async function signedRequest(
  body: Uint8Array,
  nonce: string,
  timestamp: number,
): Promise<Request> {
  const headers = await createSignedInternalQueueHeaders({
    keyId: "current",
    secret: "binary-auth-secret-that-is-at-least-thirty-two-bytes",
    audience: "zaoshi-binary-test",
    method: "POST",
    pathname: "/api/internal/generation/output",
    body,
    timestamp,
    nonce,
    contentType: "image/png",
  });
  const stable = new Uint8Array(body.byteLength);
  stable.set(body);
  return new Request("https://zaoshi.example/api/internal/generation/output", {
    method: "POST",
    headers,
    body: stable.buffer,
  });
}

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
