import { createHash } from "node:crypto";
import { readImageMetadata } from "@/lib/ai/image-metadata";
import {
  PROVIDER_CANARY_FIXTURE_BYTE_SIZE,
  PROVIDER_CANARY_FIXTURE_BYTES,
  PROVIDER_CANARY_FIXTURE_HEIGHT,
  PROVIDER_CANARY_FIXTURE_MIME_TYPE,
  PROVIDER_CANARY_FIXTURE_SHA256,
  PROVIDER_CANARY_FIXTURE_WIDTH,
  PROVIDER_CANARY_MODEL,
  PROVIDER_CANARY_RUN_ID,
  PROVIDER_CANARY_SESSION_TOKEN,
} from "./provider-fixture";

const digest = createHash("sha256")
  .update(PROVIDER_CANARY_RUN_ID)
  .digest("hex")
  .slice(0, 24);

const PROVIDER_CANARY_ADVANCED_SETTINGS_JSON = JSON.stringify({
  version: 1,
  geometryFidelity: "balanced",
  cameraPolicy: "locked",
  furnishingDensity: "balanced",
  materialExpression: "natural",
  lightingContrast: "balanced",
});

export const PROVIDER_CANARY_IDENTITY = {
  ownerId: `session:${createHash("sha256").update(PROVIDER_CANARY_SESSION_TOKEN).digest("hex")}`,
  assetId: `asset_provider_canary_${digest}`,
  jobId: `job_provider_canary_${digest}`,
  itemId: `qitem_job_provider_canary_${digest}_0`,
  reservationId: `billing_qitem_job_provider_canary_${digest}_0`,
  storageKey: `provider-canary/${digest}/source.png`,
  idempotencyKey: `provider-canary:${digest}`,
} as const;

export async function seedProviderCanary(input: {
  d1: D1Database;
  bucket: R2Bucket;
}): Promise<{ created: boolean; identity: typeof PROVIDER_CANARY_IDENTITY }> {
  const counts = await generationCounts(input.d1);
  if (Object.values(counts).some((count) => count !== 0)) {
    await assertExactSeed(input.d1, input.bucket);
    return { created: false, identity: PROVIDER_CANARY_IDENTITY };
  }

  const stored = await input.bucket.put(
    PROVIDER_CANARY_IDENTITY.storageKey,
    PROVIDER_CANARY_FIXTURE_BYTES,
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: PROVIDER_CANARY_FIXTURE_MIME_TYPE },
      customMetadata: {
        assetId: PROVIDER_CANARY_IDENTITY.assetId,
        sha256: PROVIDER_CANARY_FIXTURE_SHA256,
        kind: "source",
        sanitizationVersion: "canonical-image-v1",
      },
    },
  );
  if (stored === null) await assertStoredFixture(input.bucket);

  const requestHash = createHash("sha256")
    .update(`provider-canary:v1:${PROVIDER_CANARY_MODEL}:${PROVIDER_CANARY_FIXTURE_SHA256}`)
    .digest("hex");
  const now = new Date().toISOString();
  await input.d1.batch([
    input.d1.prepare(
      `INSERT INTO credit_ledger_entries
        (id, owner_id, entry_type, amount, idempotency_key, reason_code, actor_id, request_id)
       VALUES (?, ?, 'CREDIT', 1, ?, 'PROVIDER_CANARY_CREDIT', 'system', ?)`,
    ).bind(
      `ledger_credit_provider_canary_${digest}`,
      PROVIDER_CANARY_IDENTITY.ownerId,
      `credit:provider-canary:${digest}`,
      PROVIDER_CANARY_RUN_ID,
    ),
    input.d1
      .prepare(
        `INSERT INTO assets
          (id, owner_id, kind, status, original_file_name, mime_type,
           byte_size, sha256, sanitization_version, storage_key, created_at, moderation_status)
         VALUES (?, ?, 'source', 'READY', 'synthetic-interior-480.png',
                 'image/png', ?, ?, 'canonical-image-v1', ?, ?, 'APPROVED')`,
      )
      .bind(
        PROVIDER_CANARY_IDENTITY.assetId,
        PROVIDER_CANARY_IDENTITY.ownerId,
        PROVIDER_CANARY_FIXTURE_BYTE_SIZE,
        PROVIDER_CANARY_FIXTURE_SHA256,
        PROVIDER_CANARY_IDENTITY.storageKey,
        now,
      ),
    input.d1
      .prepare(
        `INSERT INTO generation_jobs
          (id, owner_id, source_asset_id, reference_asset_id,
           additional_references_json, mask_asset_id, depth_asset_id,
           normal_asset_id, workflow_type, purpose, source_job_id,
           promoted_from_asset_id, resolution, effective_resolution,
           aspect_ratio, quality, visual_realism, lamp_state,
           color_temperature_kelvin, style_preset_id, lighting_preset,
           preservation_mode, provider_preference, edit_instruction,
           custom_prompt, output_count, advanced_settings_json,
           idempotency_key, request_hash, status, completed_output_count,
           created_at, updated_at)
         VALUES (?, ?, ?, NULL, '[]', NULL, NULL, NULL, 'concept', 'final',
                 NULL, NULL, '2K', '2K', '1:1', 'draft', 'photorealistic',
                 'mixed', 4000, 'modern-minimalist', 'noon', 'structure',
                 ?, NULL, NULL, 1, ?, ?, ?, 'QUEUED', 0, ?, ?)`,
      )
      .bind(
        PROVIDER_CANARY_IDENTITY.jobId,
        PROVIDER_CANARY_IDENTITY.ownerId,
        PROVIDER_CANARY_IDENTITY.assetId,
        PROVIDER_CANARY_MODEL,
        PROVIDER_CANARY_ADVANCED_SETTINGS_JSON,
        PROVIDER_CANARY_IDENTITY.idempotencyKey,
        requestHash,
        now,
        now,
      ),
    input.d1
      .prepare(
        `INSERT INTO generation_job_items
          (id, job_id, owner_id, ordinal, provider_preference,
           provider_key, execution_kind, max_attempts)
         VALUES (?, ?, ?, 0, ?, 'seedream', 'provider', 1)`,
      )
      .bind(
        PROVIDER_CANARY_IDENTITY.itemId,
        PROVIDER_CANARY_IDENTITY.jobId,
        PROVIDER_CANARY_IDENTITY.ownerId,
        PROVIDER_CANARY_MODEL,
      ),
    input.d1.prepare(
      `INSERT INTO credit_ledger_entries
        (id, owner_id, entry_type, amount, reservation_id, job_id, item_id,
         idempotency_key, reason_code, price_version, actor_id, request_id)
       VALUES (?, ?, 'RESERVE', 1, ?, ?, ?, ?, 'PROVIDER_CANARY_RESERVED',
               'provider-canary-v1', 'system', ?)`,
    ).bind(
      `ledger_reserve_${PROVIDER_CANARY_IDENTITY.reservationId}`,
      PROVIDER_CANARY_IDENTITY.ownerId,
      PROVIDER_CANARY_IDENTITY.reservationId,
      PROVIDER_CANARY_IDENTITY.jobId,
      PROVIDER_CANARY_IDENTITY.itemId,
      `reserve:${PROVIDER_CANARY_IDENTITY.reservationId}`,
      PROVIDER_CANARY_RUN_ID,
    ),
  ]);
  await assertExactSeed(input.d1, input.bucket);
  return { created: true, identity: PROVIDER_CANARY_IDENTITY };
}

export async function inspectProviderCanary(input: {
  d1: D1Database;
  bucket: R2Bucket;
}): Promise<Record<string, unknown>> {
  const row = await readCanaryRow(input.d1);
  if (!row) throw new Error("PROVIDER_CANARY_NOT_FOUND");
  const counts = await generationCounts(input.d1);
  const output = row.output_storage_key
    ? await input.bucket.get(String(row.output_storage_key))
    : null;
  let outputMetadata: Record<string, unknown> | null = null;
  if (output) {
    const bytes = new Uint8Array(await output.arrayBuffer());
    const mimeType = String(row.output_mime_type);
    const metadata = readImageMetadata({
      bytes,
      mimeType: mimeType as "image/png" | "image/jpeg" | "image/webp",
    });
    outputMetadata = {
      mimeType,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      width: metadata.width,
      height: metadata.height,
    };
  }
  return {
    runId: PROVIDER_CANARY_RUN_ID,
    model: row.provider_preference,
    jobStatus: row.job_status,
    completedOutputCount: row.completed_output_count,
    itemStatus: row.item_status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    attemptState: row.attempt_state,
    provider: row.provider,
    executionModel: row.model,
    providerRequestId: row.provider_request_id,
    providerStartedAt: row.provider_started_at,
    providerRespondedAt: row.provider_responded_at,
    attemptFinishedAt: row.attempt_finished_at,
    outputCommitState: row.output_commit_state,
    outputRelationCount: row.output_relation_count,
    reconciliationCount: counts.reconciliationCases,
    deadLetterCount: counts.deadLetters,
    input: {
      mimeType: PROVIDER_CANARY_FIXTURE_MIME_TYPE,
      byteSize: PROVIDER_CANARY_FIXTURE_BYTE_SIZE,
      sha256: PROVIDER_CANARY_FIXTURE_SHA256,
      width: PROVIDER_CANARY_FIXTURE_WIDTH,
      height: PROVIDER_CANARY_FIXTURE_HEIGHT,
    },
    output: outputMetadata,
    counts,
  };
}

async function assertExactSeed(d1: D1Database, bucket: R2Bucket): Promise<void> {
  const row = await readCanaryRow(d1);
  const counts = await generationCounts(d1);
  if (
    !row ||
    counts.assets !== 1 ||
    counts.jobs !== 1 ||
    counts.items !== 1 ||
    counts.attempts !== 0 ||
    counts.outputCommits !== 0 ||
    counts.jobOutputs !== 0 ||
    counts.reconciliationCases !== 0 ||
    counts.deadLetters !== 0 ||
    row.owner_id !== PROVIDER_CANARY_IDENTITY.ownerId ||
    row.source_asset_id !== PROVIDER_CANARY_IDENTITY.assetId ||
    row.provider_preference !== PROVIDER_CANARY_MODEL ||
    row.job_status !== "QUEUED" ||
    row.item_status !== "QUEUED" ||
    row.billing_reservation_id !== PROVIDER_CANARY_IDENTITY.reservationId ||
    row.attempt_count !== 0 ||
    row.max_attempts !== 1 ||
    row.advanced_settings_json !== PROVIDER_CANARY_ADVANCED_SETTINGS_JSON
  ) {
    throw new Error("PROVIDER_CANARY_DATABASE_NOT_PRISTINE");
  }
  await assertStoredFixture(bucket);
}

async function assertStoredFixture(bucket: R2Bucket): Promise<void> {
  const object = await bucket.get(PROVIDER_CANARY_IDENTITY.storageKey);
  if (!object) throw new Error("PROVIDER_CANARY_FIXTURE_MISSING");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    bytes.byteLength !== PROVIDER_CANARY_FIXTURE_BYTE_SIZE ||
    createHash("sha256").update(bytes).digest("hex") !==
      PROVIDER_CANARY_FIXTURE_SHA256
  ) {
    throw new Error("PROVIDER_CANARY_FIXTURE_CONFLICT");
  }
}

async function readCanaryRow(d1: D1Database): Promise<Record<string, unknown> | null> {
  return d1
    .prepare(
      `SELECT job.owner_id, job.source_asset_id, job.provider_preference,
              job.advanced_settings_json,
              job.status AS job_status, job.completed_output_count,
              item.status AS item_status, item.attempt_count,
              item.max_attempts, item.billing_reservation_id,
              attempt.state AS attempt_state,
              attempt.provider, attempt.model, attempt.provider_request_id,
              attempt.provider_started_at, attempt.provider_responded_at,
              attempt.finished_at AS attempt_finished_at,
              commit_record.state AS output_commit_state,
              output_asset.storage_key AS output_storage_key,
              output_asset.mime_type AS output_mime_type,
              (SELECT COUNT(*) FROM generation_job_outputs
               WHERE job_id = job.id) AS output_relation_count
       FROM generation_jobs AS job
       JOIN generation_job_items AS item ON item.job_id = job.id
       LEFT JOIN generation_attempts AS attempt
         ON attempt.id = item.current_attempt_id
       LEFT JOIN generation_output_commits AS commit_record
         ON commit_record.item_id = item.id
       LEFT JOIN generation_job_outputs AS relation
         ON relation.job_id = job.id AND relation.ordinal = 0
       LEFT JOIN assets AS output_asset ON output_asset.id = relation.asset_id
       WHERE job.id = ? AND item.id = ?`,
    )
    .bind(PROVIDER_CANARY_IDENTITY.jobId, PROVIDER_CANARY_IDENTITY.itemId)
    .first<Record<string, unknown>>();
}

async function generationCounts(d1: D1Database): Promise<Record<string, number>> {
  const row = await d1
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM assets) AS assets,
         (SELECT COUNT(*) FROM generation_jobs) AS jobs,
         (SELECT COUNT(*) FROM generation_job_items) AS items,
         (SELECT COUNT(*) FROM generation_attempts) AS attempts,
         (SELECT COUNT(*) FROM generation_output_commits) AS output_commits,
         (SELECT COUNT(*) FROM generation_job_outputs) AS job_outputs,
         (SELECT COUNT(*) FROM generation_reconciliation_cases) AS reconciliation_cases,
         (SELECT COUNT(*) FROM generation_dead_letter_entries) AS dead_letters`,
    )
    .first<Record<string, number>>();
  return {
    assets: row?.assets ?? 0,
    jobs: row?.jobs ?? 0,
    items: row?.items ?? 0,
    attempts: row?.attempts ?? 0,
    outputCommits: row?.output_commits ?? 0,
    jobOutputs: row?.job_outputs ?? 0,
    reconciliationCases: row?.reconciliation_cases ?? 0,
    deadLetters: row?.dead_letters ?? 0,
  };
}
