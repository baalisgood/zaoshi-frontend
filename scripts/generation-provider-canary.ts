import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readImageMetadata } from "@/lib/ai/image-metadata";
import {
  PROVIDER_CANARY_CONFIRMATION,
  PROVIDER_CANARY_RUN_ID,
  PROVIDER_CANARY_SESSION_TOKEN,
} from "@/lib/canary/provider-fixture";
import {
  inspectProviderCanary,
  PROVIDER_CANARY_IDENTITY,
  seedProviderCanary,
} from "@/lib/canary/provider-store";
import { createProviderCanaryExecutor } from "@/lib/canary/provider-executor";
import { createDurablePaidRunMarker } from "@/lib/canary/paid-marker";
import { readConsumerSecretFile } from "@/lib/consumer/config";
import { HttpConsumerControlPlane } from "@/lib/consumer/control-plane-client";
import type { GenerationExecutor } from "@/lib/consumer/contracts";
import { runOne } from "@/lib/consumer/run-one";
import { FileSystemConsumerSpool } from "@/lib/consumer/spool";
import { openNodeD1Database } from "@/lib/platform/node-d1";
import { NodeObjectBucket } from "@/lib/platform/node-object-store";
import { createHash } from "node:crypto";

const command = process.argv[2] ?? "";

try {
  if (command === "seed") {
    const storage = storageConfig();
    const result = await seedProviderCanary({
      d1: openNodeD1Database(storage),
      bucket: new NodeObjectBucket(storage.objectRoot),
    });
    writeResult({ command, runId: PROVIDER_CANARY_RUN_ID, created: result.created });
  } else if (command === "run") {
    requireConfirmation();
    const marker = "/var/lib/zaoshi/provider-canary/spool/.paid-run-used";
    await requireEmptySpool(dirname(marker));
    await requirePristineCanaryHttp();
    const config = await runnerConfig();
    const control = new HttpConsumerControlPlane(
      "http://zaoshi-web:3000/",
      config.credentials,
      globalThis.fetch,
      "private-docker",
      "provider",
    );
    await createDurablePaidRunMarker(marker, `${new Date().toISOString()}\n`);
    const result = await runOne({
      workerId: "provider-canary-v1",
      claimRequestId: `claim_provider_canary_${createHash("sha256").update(PROVIDER_CANARY_RUN_ID).digest("hex").slice(0, 24)}`,
      control,
      executor: createProviderCanaryExecutor({
        slot: {
          id: "seedream-canary-v1",
          provider: "seedream",
          apiKey: config.seedreamApiKey,
        },
        fetch: globalThis.fetch,
        providerRequestTimeoutMs: 120_000,
      }),
      spool: new FileSystemConsumerSpool(dirname(marker)),
      heartbeatIntervalMs: 8_000,
      expectedItemId: PROVIDER_CANARY_IDENTITY.itemId,
    });
    writeResult({ command, runId: PROVIDER_CANARY_RUN_ID, status: result.status });
    if (result.status !== "completed") process.exitCode = 2;
  } else if (command === "recover") {
    const marker = "/var/lib/zaoshi/provider-canary/spool/.paid-run-used";
    if (await pathExists("/run/secrets/seedream-api-key")) {
      throw new Error("PROVIDER_CANARY_RECOVERY_KEY_PRESENT");
    }
    await requirePaidMarker(marker);
    const spool = new FileSystemConsumerSpool(dirname(marker));
    const pending = (await spool.list()).filter(
      (record) => record.fence.itemId === PROVIDER_CANARY_IDENTITY.itemId,
    );
    if (pending.length !== 1) throw new Error("PROVIDER_CANARY_RECOVERY_NOT_AVAILABLE");
    const config = await controlConfig();
    const result = await runOne({
      workerId: "provider-canary-recovery-v1",
      claimRequestId: "provider-canary-recovery-must-not-claim",
      control: new HttpConsumerControlPlane(
        "http://zaoshi-web:3000/",
        config.credentials,
        globalThis.fetch,
        "private-docker",
        "provider",
      ),
      executor: noProviderExecutor(),
      spool,
      heartbeatIntervalMs: 8_000,
      expectedItemId: PROVIDER_CANARY_IDENTITY.itemId,
    });
    writeResult({ command, runId: PROVIDER_CANARY_RUN_ID, status: result.status });
    if (result.status !== "completed") process.exitCode = 2;
  } else if (command === "verify-http") {
    const base = "http://zaoshi-web:3000";
    const cookie = `designer_session=${PROVIDER_CANARY_SESSION_TOKEN}`;
    const jobsResponse = await fetch(`${base}/api/jobs?workflowType=concept&limit=20`, {
      headers: { cookie },
      redirect: "error",
    });
    if (jobsResponse.status !== 200) throw new Error("PROVIDER_CANARY_JOB_HTTP_FAILED");
    const jobsBody = (await jobsResponse.json()) as Record<string, unknown>;
    const jobs = Array.isArray(jobsBody.jobs) ? jobsBody.jobs : [];
    const job = jobs.find(
      (entry) =>
        entry && typeof entry === "object" &&
        (entry as Record<string, unknown>).id === PROVIDER_CANARY_IDENTITY.jobId,
    ) as Record<string, unknown> | undefined;
    if (
      !job ||
      job.status !== "SUCCEEDED" ||
      job.providerPreference !== "doubao-seedream-4-5-251128" ||
      job.outputCount !== 1 ||
      job.completedOutputCount !== 1
    ) {
      throw new Error("PROVIDER_CANARY_JOB_NOT_SUCCEEDED");
    }
    const results = Array.isArray(job.results) ? job.results : [];
    const result = results[0] as Record<string, unknown> | undefined;
    if (!result || typeof result.assetId !== "string") throw new Error("PROVIDER_CANARY_OUTPUT_MISSING");
    const outputResponse = await fetch(
      `${base}/api/assets/${encodeURIComponent(result.assetId)}?download=1`,
      { headers: { cookie }, redirect: "error" },
    );
    if (outputResponse.status !== 200) throw new Error("PROVIDER_CANARY_DOWNLOAD_FAILED");
    const bytes = new Uint8Array(await outputResponse.arrayBuffer());
    const mimeType = (outputResponse.headers.get("content-type") ?? "").split(";", 1)[0]!;
    const metadata = readImageMetadata({
      bytes,
      mimeType: mimeType as "image/png" | "image/jpeg" | "image/webp",
    });
    if (
      results.length !== 1 ||
      metadata.width !== 2048 ||
      metadata.height !== 2048 ||
      Number(outputResponse.headers.get("content-length")) !== bytes.byteLength ||
      result.byteSize !== bytes.byteLength ||
      result.mimeType !== mimeType
    ) {
      throw new Error("PROVIDER_CANARY_OUTPUT_CONTRACT_FAILED");
    }
    const wrongOwner = await fetch(
      `${base}/api/assets/${encodeURIComponent(result.assetId)}?content=1`,
      { headers: { cookie: "designer_session=wrong_owner_session_20260912_fixed" }, redirect: "error" },
    );
    if (wrongOwner.status !== 404) throw new Error("PROVIDER_CANARY_OWNER_ISOLATION_FAILED");
    writeResult({
      command,
      runId: PROVIDER_CANARY_RUN_ID,
      status: "verified",
      mimeType,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: metadata.width,
      height: metadata.height,
      wrongOwnerStatus: wrongOwner.status,
    });
  } else if (command === "inspect") {
    const storage = storageConfig();
    writeResult({
      command,
      ...(await inspectProviderCanary({
        d1: openNodeD1Database(storage),
        bucket: new NodeObjectBucket(storage.objectRoot),
      })),
    });
  } else {
    throw new Error("PROVIDER_CANARY_COMMAND_REQUIRED");
  }
} catch (error) {
  process.stderr.write(`${safeErrorCode(error)}\n`);
  process.exitCode = 1;
}

function storageConfig(): {
  databasePath: string;
  migrationsDirectory: string;
  objectRoot: string;
} {
  return {
    databasePath: "/var/lib/zaoshi/provider-canary/db/zaoshi.sqlite",
    migrationsDirectory: "/app/drizzle",
    objectRoot: "/var/lib/zaoshi/provider-canary/objects",
  };
}

async function runnerConfig(): Promise<{
  credentials: { keyId: string; secret: string; audience: string };
  seedreamApiKey: string;
}> {
  const control = await controlConfig();
  return {
    ...control,
    seedreamApiKey: await readConsumerSecretFile(
      "/run/secrets/seedream-api-key",
      "PROVIDER_CANARY_SEEDREAM_KEY",
      8,
      "/run/secrets",
      { lstat, readFile },
    ),
  };
}

async function controlConfig(): Promise<{
  credentials: { keyId: string; secret: string; audience: string };
}> {
  const secretIo = { lstat, readFile };
  const secretRoot = "/run/secrets";
  return {
    credentials: {
      keyId: "provider-canary-v1",
      secret: await readConsumerSecretFile(
        "/run/secrets/provider-canary-hmac",
        "PROVIDER_CANARY_HMAC",
        32,
        secretRoot,
        secretIo,
      ),
      audience: "zaoshi-provider-canary-v1",
    },
  };
}

async function requirePristineCanaryHttp(): Promise<void> {
  const response = await fetch(
    "http://zaoshi-web:3000/api/jobs?workflowType=concept&limit=20",
    {
      headers: { cookie: `designer_session=${PROVIDER_CANARY_SESSION_TOKEN}` },
      redirect: "error",
    },
  );
  if (response.status !== 200) throw new Error("PROVIDER_CANARY_PREFLIGHT_FAILED");
  const body = (await response.json()) as Record<string, unknown>;
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  const job = jobs[0] as Record<string, unknown> | undefined;
  if (
    jobs.length !== 1 ||
    !job ||
    job.id !== PROVIDER_CANARY_IDENTITY.jobId ||
    job.status !== "QUEUED" ||
    job.providerPreference !== "doubao-seedream-4-5-251128" ||
    job.outputCount !== 1 ||
    job.completedOutputCount !== 0 ||
    job.resolution !== "2K" ||
    job.effectiveResolution !== "2K" ||
    !Array.isArray(job.results) ||
    job.results.length !== 0
  ) {
    throw new Error("PROVIDER_CANARY_DATABASE_NOT_PRISTINE");
  }
}

async function requirePaidMarker(path: string): Promise<void> {
  const value = await readFile(path, "utf8").catch(() => "");
  if (!value) throw new Error("PROVIDER_CANARY_RECOVERY_NOT_AUTHORIZED");
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch(() => false);
}

function noProviderExecutor(): GenerationExecutor {
  return {
    async prepare(): Promise<never> {
      throw new Error("PROVIDER_CANARY_RECOVERY_PROVIDER_DISABLED");
    },
  };
}

async function requireEmptySpool(path: string): Promise<void> {
  await mkdir(path, { recursive: false }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const entries = await new FileSystemConsumerSpool(path).list();
  if (entries.length !== 0) throw new Error("PROVIDER_CANARY_SPOOL_NOT_EMPTY");
}

function requireConfirmation(): void {
  if (
    process.argv.length !== 4 ||
    process.argv[3] !== `--confirm-cost=${PROVIDER_CANARY_CONFIRMATION}`
  ) {
    throw new Error("PROVIDER_CANARY_CONFIRMATION_REQUIRED");
  }
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/u.test(error.message)) {
    return error.message;
  }
  return "PROVIDER_CANARY_FAILED";
}
