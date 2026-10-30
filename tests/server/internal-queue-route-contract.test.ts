import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { requireInternalQueueClaimReady } from "../../lib/server/internal-queue-readiness";

const routes = [
  ["claim", "parseInternalClaimInput"],
  ["heartbeat", "parseInternalHeartbeatInput"],
  ["transition", "parseInternalTransitionInput"],
  ["sweep", "parseInternalSweepInput"],
  ["work", "parseInternalWorkRequestInput"],
  ["output-prepare", "parseInternalOutputPrepareRequest"],
] as const;

test("all internal queue routes use the shared signed control-plane handler", async () => {
  for (const [route, parser] of routes) {
    const source = await readFile(
      new URL(
        `../../app/api/internal/generation/${route}/route.ts`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(source, /export async function POST/u);
    assert.match(source, /handleInternalQueueRequest/u);
    assert.match(source, new RegExp(parser, "u"));
    assert.doesNotMatch(
      source,
      /\bfetch\s*\(|processGenerationJob|scheduleBackground|cookie|oai-authenticated/u,
    );
  }
});

test("binary input and output routes keep signed bounded private transport", async () => {
  const [input, output] = await Promise.all([
    readFile(
      new URL(
        "../../app/api/internal/generation/input/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../../app/api/internal/generation/output/route.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  assert.match(input, /readAuthenticatedInternalQueueJson/u);
  assert.match(input, /parseInternalInputReadRequest/u);
  assert.match(input, /private, no-store/u);
  assert.match(input, /X-Zaoshi-Content-Sha256/u);
  assert.match(output, /readAuthenticatedInternalQueueBody/u);
  assert.match(output, /MAX_INTERNAL_OUTPUT_BYTES/u);
  assert.match(output, /parseInternalOutputUploadHeaders/u);
  for (const source of [input, output]) {
    assert.match(source, /createInternalQueueExecutionService\(runtime, d1\)/u);
  }
  assert.doesNotMatch(`${input}\n${output}`, /processGenerationJob|scheduleBackground|cookie/u);
});

test("all work and output routes share acceptance-aware execution wiring", async () => {
  for (const route of ["work", "input", "output-prepare", "output"]) {
    const source = await readFile(
      new URL(
        `../../app/api/internal/generation/${route}/route.ts`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(source, /createInternalQueueExecutionService\(runtime, d1\)/u);
    assert.doesNotMatch(source, /new InternalQueueExecutionService/u);
  }
});

test("the domestic public generation gate remains fail closed", async () => {
  const [route, finalize, policy] = await Promise.all([
    readFile(new URL("../../app/api/jobs/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../app/api/jobs/[id]/finalize/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../../lib/server/runtime-policy.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(route, /assertDomesticGenerationQueueReady/u);
  assert.match(finalize, /assertDomesticGenerationQueueReady/u);
  assert.match(policy, /GENERATION_QUEUE_NOT_READY/u);
  assert.match(policy, /isDomesticImageModel\(preference\)/u);
  for (const source of [route, finalize]) {
    assert.match(source, /createQueuedJobIdempotently/u);
    assert.match(source, /assertQueuedJobItemsConsistent/u);
    assert.doesNotMatch(source, /scheduleBackground|processGenerationJob/u);
    assert.ok(
      source.indexOf("assertDomesticGenerationQueueReady") <
        source.indexOf("const result = await createQueuedJobIdempotently"),
    );
    const policyCalls = source.slice(source.indexOf("const environment"));
    assert.ok(
      policyCalls.indexOf("assertDomesticGenerationQueueReady") <
        policyCalls.indexOf("assertGenerationRuntime"),
      "the public hard gate must fail closed before Web-side provider credentials are inspected",
    );
    assert.ok(
      policyCalls.indexOf("assertDomesticGenerationQueueReady") <
        policyCalls.indexOf("createQueuedJobIdempotently"),
      "the public hard gate must fail closed before durable job admission",
    );
  }
});

test("claim checks R2 and ticket readiness before mutating queue state", async () => {
  const source = await readFile(
    new URL(
      "../../app/api/internal/generation/claim/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    source.indexOf("requireInternalQueueClaimReady(runtime)") <
      source.indexOf("service.claim("),
  );
  const base = {
    auth: {
      enabled: true as const,
      audience: "zaoshi-test",
      keys: new Map(),
    },
    d1: {} as D1Database,
    r2: {} as R2Bucket,
    ticket: {
      audience: "zaoshi-test",
      secret: "ticket-secret-that-is-at-least-thirty-two-bytes-long",
      ttlSeconds: 240,
    },
    leaseSeconds: 180,
    ownerConcurrency: 1,
    providerConcurrency: 1,
    sweepLimit: 50,
    acceptanceEnabled: false,
  };
  assert.throws(
    () => requireInternalQueueClaimReady({ ...base, r2: null }),
    hasCode("QUEUE_REQUIRES_R2"),
  );
  assert.throws(
    () => requireInternalQueueClaimReady({ ...base, ticket: null }),
    hasCode("INTERNAL_QUEUE_TICKET_MISCONFIGURED"),
  );
  assert.doesNotThrow(() => requireInternalQueueClaimReady(base));
});

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error && "code" in error && error.code === code;
}
