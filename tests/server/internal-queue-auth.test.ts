import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ApiError } from "../../lib/server/api";
import {
  createSignedInternalQueueHeaders,
  readAuthenticatedInternalQueueJson,
  resolveInternalQueueAuthConfig,
} from "../../lib/server/internal-queue-auth";
import { applyMigrations, TestD1Database } from "../helpers/test-d1";

const NOW = 1_800_000_000;
const CURRENT_SECRET = "current-secret-with-at-least-thirty-two-bytes";
const PREVIOUS_SECRET = "previous-secret-with-at-least-thirty-two-bytes";
const PATHNAME = "/api/internal/generation/claim";
const AUDIENCE = "zaoshi-test";

test("internal queue auth accepts current and previous rotation keys", async () => {
  const { d1 } = setup();
  const config = enabledConfig();
  const current = await signedRequest({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("a"),
  });
  assert.deepEqual(
    await readAuthenticatedInternalQueueJson(current, d1, config, NOW),
    { workerId: "worker-a" },
  );

  const previous = await signedRequest({
    keyId: "previous-2026-08",
    secret: PREVIOUS_SECRET,
    nonce: nonce("b"),
  });
  assert.deepEqual(
    await readAuthenticatedInternalQueueJson(previous, d1, config, NOW),
    { workerId: "worker-a" },
  );
});

test("replay, body tampering, bad signatures and unknown keys are rejected", async () => {
  const { database, d1 } = setup();
  const config = enabledConfig();
  const headers = await signedHeaders({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("c"),
  });
  const first = request(headers, '{"workerId":"worker-a"}');
  await readAuthenticatedInternalQueueJson(first, d1, config, NOW);
  await assert.rejects(
    readAuthenticatedInternalQueueJson(
      request(headers, '{"workerId":"worker-a"}'),
      d1,
      config,
      NOW,
    ),
    hasCode("INTERNAL_REQUEST_REPLAY"),
  );

  const tamperedHeaders = await signedHeaders({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("d"),
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(
      request(tamperedHeaders, '{"workerId":"worker-b"}'),
      d1,
      config,
      NOW,
    ),
    hasCode("INTERNAL_AUTH_FAILED"),
  );

  const badSignatureHeaders = await signedHeaders({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("e"),
  });
  badSignatureHeaders.set(
    "x-zaoshi-signature",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  await assert.rejects(
    readAuthenticatedInternalQueueJson(
      request(badSignatureHeaders, '{"workerId":"worker-a"}'),
      d1,
      config,
      NOW,
    ),
    hasCode("INTERNAL_AUTH_FAILED"),
  );

  const unknown = await signedRequest({
    keyId: "unknown-key",
    secret: "unknown-secret-with-at-least-thirty-two-bytes",
    nonce: nonce("f"),
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(unknown, d1, config, NOW),
    hasCode("INTERNAL_AUTH_FAILED"),
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM generation_internal_nonces")
      .get()?.count,
    1,
  );
});

test("timestamps, HTTPS, paths and the feature flag fail closed", async () => {
  const { database, d1 } = setup();
  const config = enabledConfig();
  const stale = await signedRequest({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("g"),
    timestamp: NOW - 91,
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(stale, d1, config, NOW),
    hasCode("INTERNAL_AUTH_FAILED"),
  );

  const future = await signedRequest({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("h"),
    timestamp: NOW + 91,
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(future, d1, config, NOW),
    hasCode("INTERNAL_AUTH_FAILED"),
  );

  const httpHeaders = await signedHeaders({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("i"),
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(
      new Request(`http://example.test${PATHNAME}`, {
        method: "POST",
        headers: httpHeaders,
        body: '{"workerId":"worker-a"}',
      }),
      d1,
      config,
      NOW,
    ),
    hasCode("INTERNAL_AUTH_FAILED"),
  );

  const disabled = resolveInternalQueueAuthConfig({});
  const disabledRequest = await signedRequest({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("j"),
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(disabledRequest, d1, disabled, NOW),
    hasCode("NOT_FOUND"),
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM generation_internal_nonces")
      .get()?.count,
    0,
  );
});

test("private Docker transport accepts only the dedicated Web service origin", async () => {
  const { d1 } = setup();
  const config = resolveInternalQueueAuthConfig(
    {
      GENERATION_INTERNAL_API_ENABLED: "1",
      GENERATION_INTERNAL_AUDIENCE: AUDIENCE,
      GENERATION_INTERNAL_CURRENT_KEY_ID: "current-2026-09",
      GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
      GENERATION_INTERNAL_TRANSPORT: "private-docker",
      ZAOSHI_RUNTIME: "node",
    },
    NOW,
  );
  const headers = await signedHeaders({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("k"),
  });
  assert.deepEqual(
    await readAuthenticatedInternalQueueJson(
      new Request(`http://zaoshi-web:3000${PATHNAME}`, {
        method: "POST",
        headers,
        body: '{"workerId":"worker-a"}',
      }),
      d1,
      config,
      NOW,
    ),
    { workerId: "worker-a" },
  );

  for (const [index, origin] of ["http://127.0.0.1:3000", "http://zaoshi-web:3001", "https://zaoshi-web:3000"].entries()) {
    const nextHeaders = await signedHeaders({
      keyId: "current-2026-09",
      secret: CURRENT_SECRET,
      nonce: nonce(["l", "m", "n"][index]!),
    });
    await assert.rejects(
      readAuthenticatedInternalQueueJson(
        new Request(`${origin}${PATHNAME}`, {
          method: "POST",
          headers: nextHeaders,
          body: '{"workerId":"worker-a"}',
        }),
        d1,
        config,
        NOW,
      ),
      hasCode("INTERNAL_AUTH_FAILED"),
    );
  }
});

test("private Docker transport is unavailable outside the Node runtime", () => {
  assert.throws(
    () => resolveInternalQueueAuthConfig({
      GENERATION_INTERNAL_API_ENABLED: "1",
      GENERATION_INTERNAL_AUDIENCE: AUDIENCE,
      GENERATION_INTERNAL_CURRENT_KEY_ID: "current-2026-09",
      GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
      GENERATION_INTERNAL_TRANSPORT: "private-docker",
    }, NOW),
    hasCode("INTERNAL_QUEUE_AUTH_MISCONFIGURED"),
  );
});

test("enabled auth requires a valid current key and complete previous pair", () => {
  assert.throws(
    () =>
      resolveInternalQueueAuthConfig({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_CURRENT_KEY_ID: "current",
        GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
      }),
    hasCode("INTERNAL_QUEUE_AUTH_MISCONFIGURED"),
  );
  assert.throws(
    () =>
      resolveInternalQueueAuthConfig({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_AUDIENCE: AUDIENCE,
      }),
    hasCode("INTERNAL_QUEUE_AUTH_MISCONFIGURED"),
  );
  assert.throws(
    () =>
      resolveInternalQueueAuthConfig({
        GENERATION_INTERNAL_API_ENABLED: "1",
        GENERATION_INTERNAL_AUDIENCE: AUDIENCE,
        GENERATION_INTERNAL_CURRENT_KEY_ID: "current",
        GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
        GENERATION_INTERNAL_PREVIOUS_KEY_ID: "previous",
      }),
    hasCode("INTERNAL_QUEUE_AUTH_MISCONFIGURED"),
  );
  assert.throws(
    () =>
      resolveInternalQueueAuthConfig(
        {
          GENERATION_INTERNAL_API_ENABLED: "1",
          GENERATION_INTERNAL_AUDIENCE: AUDIENCE,
          GENERATION_INTERNAL_CURRENT_KEY_ID: "current",
          GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
          GENERATION_INTERNAL_PREVIOUS_KEY_ID: "previous",
          GENERATION_INTERNAL_PREVIOUS_SECRET: PREVIOUS_SECRET,
          GENERATION_INTERNAL_PREVIOUS_EXPIRES_AT: String(
            NOW + 8 * 24 * 60 * 60,
          ),
        },
        NOW,
      ),
    hasCode("INTERNAL_QUEUE_AUTH_MISCONFIGURED"),
  );
});

test("audience binding and previous-key expiry fail closed without affecting current", async () => {
  const { d1 } = setup();
  const config = enabledConfig();
  const wrongAudience = await signedRequest({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("k"),
    audience: "zaoshi-other-environment",
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(wrongAudience, d1, config, NOW),
    hasCode("INTERNAL_AUTH_FAILED"),
  );

  const expiredConfig = resolveInternalQueueAuthConfig(
    {
      GENERATION_INTERNAL_API_ENABLED: "1",
      GENERATION_INTERNAL_AUDIENCE: AUDIENCE,
      GENERATION_INTERNAL_CURRENT_KEY_ID: "current-2026-09",
      GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
      GENERATION_INTERNAL_PREVIOUS_KEY_ID: "previous-2026-08",
      GENERATION_INTERNAL_PREVIOUS_SECRET: PREVIOUS_SECRET,
      GENERATION_INTERNAL_PREVIOUS_EXPIRES_AT: String(NOW - 1),
    },
    NOW,
  );
  const expiredPrevious = await signedRequest({
    keyId: "previous-2026-08",
    secret: PREVIOUS_SECRET,
    nonce: nonce("l"),
  });
  await assert.rejects(
    readAuthenticatedInternalQueueJson(expiredPrevious, d1, expiredConfig, NOW),
    hasCode("INTERNAL_AUTH_FAILED"),
  );
  const current = await signedRequest({
    keyId: "current-2026-09",
    secret: CURRENT_SECRET,
    nonce: nonce("m"),
  });
  assert.deepEqual(
    await readAuthenticatedInternalQueueJson(current, d1, expiredConfig, NOW),
    { workerId: "worker-a" },
  );
});

function setup(): {
  database: DatabaseSync;
  d1: D1Database;
} {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON;");
  applyMigrations(database);
  return {
    database,
    d1: new TestD1Database(database) as unknown as D1Database,
  };
}

function enabledConfig() {
  return resolveInternalQueueAuthConfig(
    {
      GENERATION_INTERNAL_API_ENABLED: "1",
      GENERATION_INTERNAL_AUDIENCE: AUDIENCE,
      GENERATION_INTERNAL_CURRENT_KEY_ID: "current-2026-09",
      GENERATION_INTERNAL_CURRENT_SECRET: CURRENT_SECRET,
      GENERATION_INTERNAL_PREVIOUS_KEY_ID: "previous-2026-08",
      GENERATION_INTERNAL_PREVIOUS_SECRET: PREVIOUS_SECRET,
      GENERATION_INTERNAL_PREVIOUS_EXPIRES_AT: String(NOW + 3600),
    },
    NOW,
  );
}

async function signedRequest(options: {
  keyId: string;
  secret: string;
  nonce: string;
  timestamp?: number;
  audience?: string;
}): Promise<Request> {
  return request(await signedHeaders(options), '{"workerId":"worker-a"}');
}

async function signedHeaders(options: {
  keyId: string;
  secret: string;
  nonce: string;
  timestamp?: number;
  audience?: string;
}): Promise<Headers> {
  return createSignedInternalQueueHeaders({
    keyId: options.keyId,
    secret: options.secret,
    audience: options.audience ?? AUDIENCE,
    nonce: options.nonce,
    timestamp: options.timestamp ?? NOW,
    method: "POST",
    pathname: PATHNAME,
    body: new TextEncoder().encode('{"workerId":"worker-a"}'),
  });
}

function request(headers: Headers, body: string): Request {
  return new Request(`https://example.test${PATHNAME}`, {
    method: "POST",
    headers: new Headers(headers),
    body,
  });
}

function nonce(character: string): string {
  return character.repeat(22);
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof ApiError && error.code === code;
}
