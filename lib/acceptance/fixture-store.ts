import { createHash } from "node:crypto";
import {
  ACCEPTANCE_FIXTURE_BYTE_SIZE,
  ACCEPTANCE_FIXTURE_MIME_TYPE,
  ACCEPTANCE_FIXTURE_SHA256,
  ACCEPTANCE_MODEL,
  acceptanceScenarioFromRunId,
  isAcceptanceScenario,
  type AcceptanceScenario,
} from "@/lib/domain/acceptance-fixture";
import {
  ACCEPTANCE_FIXTURE_BYTES,
} from "./fixture";

const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/u;
export type AcceptanceRunIdentity = {
  runId: string;
  ownerId: string;
  assetId: string;
  jobId: string;
  itemId: string;
  workerId: string;
  claimRequestId: string;
  recoveryClaimRequestId: string;
  storageKey: string;
};

export function acceptanceRunIdentity(runId: string): AcceptanceRunIdentity {
  if (!RUN_ID.test(runId)) throw new Error("INVALID_ACCEPTANCE_RUN_ID");
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 24);
  const jobId = `job_acceptance_${digest}`;
  return {
    runId,
    ownerId: `queue_acceptance:${digest}`,
    assetId: `asset_acceptance_${digest}`,
    jobId,
    itemId: `qitem_${jobId}_0`,
    workerId: `acceptance_${digest}`,
    claimRequestId: `claim_acceptance_${digest}`,
    recoveryClaimRequestId: `claim_acceptance_recovery_${digest}`,
    storageKey: `acceptance/${digest}/source.png`,
  };
}

export async function seedAcceptanceRun(input: {
  d1: D1Database;
  bucket: R2Bucket;
  runId: string;
  scenario?: AcceptanceScenario;
}): Promise<AcceptanceRunIdentity> {
  const identity = acceptanceRunIdentity(input.runId);
  const scenario = input.scenario ?? acceptanceScenarioFromRunId(input.runId);
  if (
    !isAcceptanceScenario(scenario) ||
    scenario !== acceptanceScenarioFromRunId(input.runId)
  ) {
    throw new Error("INVALID_ACCEPTANCE_SCENARIO");
  }
  await assertAcceptanceOnlyDatabase(input.d1);

  const stored = await input.bucket.put(
    identity.storageKey,
    ACCEPTANCE_FIXTURE_BYTES,
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: ACCEPTANCE_FIXTURE_MIME_TYPE },
      customMetadata: {
        assetId: identity.assetId,
        sha256: ACCEPTANCE_FIXTURE_SHA256,
        kind: "source",
      },
    },
  );
  if (stored === null) await assertStoredFixture(input.bucket, identity);

  const requestHash = createHash("sha256")
    .update(`acceptance:v1:${identity.runId}:${scenario}:${ACCEPTANCE_FIXTURE_SHA256}`)
    .digest("hex");
  const maxAttempts = scenario === "claim_ack_loss" ? 2 : 1;
  await input.d1.batch([
    input.d1
      .prepare(
        `INSERT OR IGNORE INTO assets
          (id, owner_id, kind, status, original_file_name, mime_type,
           byte_size, sha256, storage_key, created_at)
         VALUES (?, ?, 'source', 'READY', 'acceptance-fixture.png',
                 'image/png', ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .bind(
        identity.assetId,
        identity.ownerId,
        ACCEPTANCE_FIXTURE_BYTE_SIZE,
        ACCEPTANCE_FIXTURE_SHA256,
        identity.storageKey,
      ),
    input.d1
      .prepare(
        `INSERT OR IGNORE INTO generation_jobs
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
                 NULL, NULL, '1K', '0.5K', '1:1', 'draft', 'conceptual',
                 'off', 4000, 'acceptance-fixture-v1', 'noon', 'restyle',
                 ?, NULL, NULL, 1, '{}', ?, ?, 'QUEUED', 0,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(
        identity.jobId,
        identity.ownerId,
        identity.assetId,
        ACCEPTANCE_MODEL,
        `acceptance:${identity.runId}`,
        requestHash,
      ),
    input.d1
      .prepare(
        `INSERT OR IGNORE INTO generation_job_items
          (id, job_id, owner_id, ordinal, provider_preference,
           provider_key, execution_kind, max_attempts)
         VALUES (?, ?, ?, 0, ?, 'acceptance', 'acceptance', ?)`,
      )
      .bind(
        identity.itemId,
        identity.jobId,
        identity.ownerId,
        ACCEPTANCE_MODEL,
        maxAttempts,
      ),
    input.d1
      .prepare(
        `INSERT OR IGNORE INTO generation_acceptance_runs
          (run_id, item_id, scenario, fixture_sha256)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(
        identity.runId,
        identity.itemId,
        scenario,
        ACCEPTANCE_FIXTURE_SHA256,
      ),
  ]);
  await assertSeededRun(
    input.d1,
    identity,
    scenario,
    requestHash,
    maxAttempts,
  );
  await assertStoredFixture(input.bucket, identity);
  return identity;
}

export async function inspectAcceptanceRun(
  d1: D1Database,
  runId: string,
): Promise<Record<string, unknown>> {
  const identity = acceptanceRunIdentity(runId);
  const row = await d1
    .prepare(
      `SELECT run.run_id, run.scenario, job.status AS job_status,
              item.status AS item_status, item.attempt_count,
              item.lease_generation, item.lease_expires_at,
              item.next_attempt_at, item.last_error_code,
              item.last_error_retryable, attempt.state AS attempt_state,
              attempt.provider, attempt.model,
              attempt.retry_class, attempt.error_code AS attempt_error_code,
              output.state AS output_commit_state,
              CASE WHEN relation.asset_id IS NULL THEN 0 ELSE 1 END AS output_count
       FROM generation_acceptance_runs AS run
       JOIN generation_job_items AS item ON item.id = run.item_id
       JOIN generation_jobs AS job ON job.id = item.job_id
       LEFT JOIN generation_attempts AS attempt ON attempt.id = item.current_attempt_id
       LEFT JOIN generation_output_commits AS output ON output.item_id = item.id
       LEFT JOIN generation_job_outputs AS relation ON relation.job_id = job.id
       WHERE run.run_id = ? AND item.id = ?`,
    )
    .bind(identity.runId, identity.itemId)
    .first<Record<string, unknown>>();
  if (!row) throw new Error("ACCEPTANCE_RUN_NOT_FOUND");
  return {
    runId: row.run_id,
    scenario: row.scenario,
    jobStatus: row.job_status,
    itemStatus: row.item_status,
    attemptCount: row.attempt_count,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    lastErrorCode: row.last_error_code,
    lastErrorRetryable:
      row.last_error_retryable === null
        ? null
        : row.last_error_retryable === 1,
    attemptState: row.attempt_state,
    executionProvider: row.provider,
    executionModel: row.model,
    retryClass: row.retry_class,
    attemptErrorCode: row.attempt_error_code,
    outputCommitState: row.output_commit_state,
    outputCount: row.output_count,
  };
}

async function assertAcceptanceOnlyDatabase(d1: D1Database): Promise<void> {
  const row = await d1
    .prepare(
      `SELECT COUNT(*) AS count FROM generation_jobs
       WHERE owner_id NOT LIKE 'queue_acceptance:%'`,
    )
    .first<{ count: number }>();
  if ((row?.count ?? 0) !== 0) throw new Error("ACCEPTANCE_DATABASE_NOT_ISOLATED");
}

async function assertStoredFixture(
  bucket: R2Bucket,
  identity: AcceptanceRunIdentity,
): Promise<void> {
  const object = await bucket.get(identity.storageKey);
  if (!object) throw new Error("ACCEPTANCE_FIXTURE_MISSING");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (
    bytes.byteLength !== ACCEPTANCE_FIXTURE_BYTE_SIZE ||
    createHash("sha256").update(bytes).digest("hex") !==
      ACCEPTANCE_FIXTURE_SHA256
  ) {
    throw new Error("ACCEPTANCE_FIXTURE_CONFLICT");
  }
}

async function assertSeededRun(
  d1: D1Database,
  identity: AcceptanceRunIdentity,
  scenario: AcceptanceScenario,
  requestHash: string,
  maxAttempts: number,
): Promise<void> {
  const row = await d1
    .prepare(
      `SELECT asset.owner_id, asset.sha256, asset.storage_key,
              job.owner_id AS job_owner_id, job.source_asset_id,
              job.provider_preference, job.request_hash,
              item.owner_id AS item_owner_id, item.provider_key,
              item.provider_preference AS item_model, item.execution_kind,
              item.max_attempts,
              run.scenario, run.fixture_sha256
       FROM generation_acceptance_runs AS run
       JOIN generation_job_items AS item ON item.id = run.item_id
       JOIN generation_jobs AS job ON job.id = item.job_id
       JOIN assets AS asset ON asset.id = job.source_asset_id
       WHERE run.run_id = ? AND run.item_id = ?`,
    )
    .bind(identity.runId, identity.itemId)
    .first<Record<string, unknown>>();
  if (
    !row ||
    row.owner_id !== identity.ownerId ||
    row.job_owner_id !== identity.ownerId ||
    row.item_owner_id !== identity.ownerId ||
    row.source_asset_id !== identity.assetId ||
    row.storage_key !== identity.storageKey ||
    row.sha256 !== ACCEPTANCE_FIXTURE_SHA256 ||
    row.fixture_sha256 !== ACCEPTANCE_FIXTURE_SHA256 ||
    row.provider_preference !== ACCEPTANCE_MODEL ||
    row.item_model !== ACCEPTANCE_MODEL ||
    row.provider_key !== "acceptance" ||
    row.execution_kind !== "acceptance" ||
    row.max_attempts !== maxAttempts ||
    row.scenario !== scenario ||
    row.request_hash !== requestHash
  ) {
    throw new Error("ACCEPTANCE_RUN_CONFLICT");
  }
}
