import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ConsumerControlPlaneError,
  HttpConsumerControlPlane,
} from "../../lib/consumer/control-plane-client";

const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const fence = {
  itemId: "qitem-client-1",
  leaseToken: "lease-client-1",
  leaseGeneration: 1,
};

test("HTTP consumer client signs fixed JSON and binary endpoints", async () => {
  const requests: Request[] = [];
  const client = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    {
      keyId: "consumer-test",
      secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
      audience: "zaoshi-client-test",
    },
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/input")) {
        return new Response(PNG_BYTES.slice().buffer, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(PNG_BYTES.byteLength),
            "X-Zaoshi-Content-Sha256": digest(PNG_BYTES),
          },
        });
      }
      if (pathname.endsWith("/output")) {
        return Response.json({ output: { result: "applied" } });
      }
      throw new Error(`unexpected path ${pathname}`);
    },
  );

  assert.deepEqual(await client.input(fence, "input-ticket"), {
    bytes: PNG_BYTES,
    mimeType: "image/png",
    sha256: digest(PNG_BYTES),
  });
  assert.equal(
    await client.uploadOutput(
      fence,
      "output-ticket",
      "image/png",
      PNG_BYTES,
    ),
    "applied",
  );
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "error");
    assert.ok(request.headers.get("x-zaoshi-signature"));
    assert.ok(request.headers.get("x-zaoshi-content-sha256"));
  }
  assert.equal(
    requests[1]!.headers.get("x-zaoshi-output-ticket"),
    "output-ticket",
  );
  assert.equal(requests[1]!.headers.get("x-zaoshi-lease-token"), fence.leaseToken);
});

test("HTTP consumer client rejects non-HTTPS or credentialed control URLs", () => {
  const credentials = {
    keyId: "consumer-test",
    secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
    audience: "zaoshi-client-test",
  };
  assert.throws(
    () => new HttpConsumerControlPlane("http://zaoshi.example/", credentials),
    /INVALID_CONTROL_PLANE_URL/u,
  );
  assert.throws(
    () =>
      new HttpConsumerControlPlane(
        "https://name:password@zaoshi.example/",
        credentials,
      ),
    /INVALID_CONTROL_PLANE_URL/u,
  );
});

test("HTTP consumer client allows only its explicit private Docker service origin", async () => {
  const credentials = {
    keyId: "consumer-test",
    secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
    audience: "zaoshi-client-test",
  };
  const client = new HttpConsumerControlPlane(
    "http://zaoshi-web:3000/",
    credentials,
    async () => new Response(null, { status: 204 }),
    "private-docker",
  );
  assert.equal(await client.claim("worker-client", "claim-client"), null);
  for (const value of [
    "http://127.0.0.1:3000/",
    "http://zaoshi-web:3001/",
    "http://zaoshi-web:3000/path",
  ]) {
    assert.throws(
      () => new HttpConsumerControlPlane(value, credentials, globalThis.fetch, "private-docker"),
      /INVALID_CONTROL_PLANE_URL/u,
    );
  }
});

test("HTTP consumer claims are explicitly separated by execution kind", async () => {
  const requests: Request[] = [];
  const credentials = {
    keyId: "consumer-test",
    secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
    audience: "zaoshi-client-test",
  };
  const fetchImplementation = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init).clone());
    return new Response(null, { status: 204 });
  };
  const provider = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    credentials,
    fetchImplementation,
  );
  const acceptance = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    credentials,
    fetchImplementation,
    "https",
    "acceptance",
    "qitem-acceptance",
  );
  await provider.claim("worker-provider", "claim-provider");
  await acceptance.claim("worker-acceptance", "claim-acceptance");
  const providerBody = await requests[0]!.json();
  const acceptanceBody = await requests[1]!.json();
  assert.equal(providerBody.executionKind, "provider");
  assert.equal(acceptanceBody.executionKind, "acceptance");
  assert.equal(acceptanceBody.targetItemId, "qitem-acceptance");
  assert.throws(
    () =>
      new HttpConsumerControlPlane(
        "https://zaoshi.example/",
        credentials,
        fetchImplementation,
        "https",
        "acceptance",
      ),
    /CONTROL_PLANE_ACCEPTANCE_TARGET_INVALID/u,
  );
  assert.throws(
    () =>
      new HttpConsumerControlPlane(
        "https://zaoshi.example/",
        credentials,
        fetchImplementation,
        "https",
        "provider",
        "qitem-provider",
      ),
    /CONTROL_PLANE_ACCEPTANCE_TARGET_INVALID/u,
  );
});

test("HTTP consumer client exposes stale mutation results as terminal fence errors", async () => {
  const client = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    {
      keyId: "consumer-test",
      secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
      audience: "zaoshi-client-test",
    },
    async () => Response.json({ result: "stale" }),
  );
  await assert.rejects(client.heartbeat(fence), (error: unknown) => {
    assert.ok(error instanceof ConsumerControlPlaneError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "QUEUE_FENCE_STALE");
    return true;
  });
});

test("HTTP consumer client rejects malformed claim leases before execution", async () => {
  const client = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    {
      keyId: "consumer-test",
      secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
      audience: "zaoshi-client-test",
    },
    async () =>
      Response.json({
        claim: {
          item: {
            id: "qitem-client-1",
            jobId: "job-client-1",
            ordinal: 0,
            leaseExpiresAt: null,
          },
          attemptId: "attempt-client-1",
          fence,
        },
      }),
  );
  await assert.rejects(
    client.claim("worker-client", "claim-client"),
    /CONTROL_PLANE_RESPONSE_INVALID/u,
  );
});

test("HTTP consumer client strictly validates frozen work responses", async () => {
  const validWork = {
    version: 1,
    executionKind: "provider",
    itemId: fence.itemId,
    attemptId: "attempt-client-1",
    outputOrdinal: 0,
    totalOutputs: 1,
    providerPreference: "doubao-seedream-4-5-251128",
    workflowType: "concept",
    spaceType: "unspecified",
    purpose: "final",
    resolution: "2K",
    aspectRatio: "4:3",
    quality: "standard",
    visualRealism: "photorealistic",
    stylePresetId: "modern-minimalist",
    lightingPreset: "noon",
    lampState: "mixed",
    colorTemperatureKelvin: 4000,
    renovationScope: "restyle",
    promotedFromPreview: false,
    editInstruction: null,
    customPrompt: null,
    advancedSettings: null,
    outputCount: 1,
    inputs: [{
      role: "source",
      index: 0,
      mimeType: "image/png",
      byteSize: PNG_BYTES.byteLength,
      sha256: digest(PNG_BYTES),
      ticket: "t".repeat(64),
    }],
  };
  let responseWork: Record<string, unknown> = validWork;
  const client = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    {
      keyId: "consumer-test",
      secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
      audience: "zaoshi-client-test",
    },
    async () => Response.json({ work: responseWork }),
  );

  assert.deepEqual(await client.work(fence), validWork);
  responseWork = { ...validWork, providerEndpoint: "https://attacker.example" };
  await assert.rejects(client.work(fence), /CONTROL_PLANE_WORK_INVALID/u);
  responseWork = {
    ...validWork,
    inputs: [{ ...validWork.inputs[0], index: 2 }],
  };
  await assert.rejects(client.work(fence), /CONTROL_PLANE_WORK_INVALID/u);
});

test("HTTP consumer client signs sweep and strictly validates counters", async () => {
  const requests: Request[] = [];
  let summary: Record<string, unknown> = {
    retried: 1,
    failed: 2,
    reconciliationRequired: 3,
    outputsRecovered: 4,
    outputReconciliationRequired: 5,
  };
  const client = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    {
      keyId: "consumer-test",
      secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
      audience: "zaoshi-client-test",
    },
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return Response.json({ summary });
    },
  );
  assert.deepEqual(await client.sweep(), summary);
  assert.equal(new URL(requests[0]!.url).pathname, "/api/internal/generation/sweep");
  assert.deepEqual(await requests[0]!.json(), {});
  assert.ok(requests[0]!.headers.get("x-zaoshi-signature"));

  const acceptanceClient = new HttpConsumerControlPlane(
    "https://zaoshi.example/",
    {
      keyId: "consumer-test",
      secret: "consumer-machine-secret-that-is-at-least-thirty-two-bytes",
      audience: "zaoshi-client-test",
    },
    async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return Response.json({ summary });
    },
    "https",
    "acceptance",
    "qitem_job_acceptance_target_0",
  );
  assert.deepEqual(await acceptanceClient.sweep(), summary);
  assert.deepEqual(await requests[1]!.json(), {
    executionKind: "acceptance",
    targetItemId: "qitem_job_acceptance_target_0",
  });

  summary = { retried: -1, failed: 0, reconciliationRequired: 0 };
  await assert.rejects(client.sweep(), /CONTROL_PLANE_RESPONSE_INVALID/u);
  summary = {
    retried: 0,
    failed: 0,
    reconciliationRequired: 0,
    unexpected: 1,
  };
  await assert.rejects(client.sweep(), /CONTROL_PLANE_RESPONSE_INVALID/u);
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
