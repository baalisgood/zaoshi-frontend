import { userEditInstruction } from "@/lib/domain/bare-shell";
import { createHash } from "node:crypto";

import {
  imageModelProvider,
  isOverseasImageModel,
  isImageModel,
  type ImageModel,
} from "@/lib/domain/image-models";
import { ApiError } from "./api";
import {
  assertGenerationPriceExpectation,
  isInsufficientCreditsError,
  validateGenerationBilling,
  type GenerationBilling,
  type GenerationPriceExpectation,
} from "./credit-ledger";
import { D1GenerationQueue, queueItemId } from "./generation-queue";
import { startOfTodayInShanghai } from "./product-time";
import { PRIVATE_TEST_OWNER } from "./private-test";

const MAX_OUTPUT_ITEMS = 4;

export type D1QueuedJobRecord = {
  id: string;
  ownerId: string;
  sourceAssetId: string | null;
  referenceAssetId: string | null;
  additionalReferencesJson: string;
  maskAssetId: string | null;
  depthAssetId: string | null;
  normalAssetId: string | null;
  workflowType: string;
  purpose: string;
  sourceJobId: string | null;
  promotedFromAssetId: string | null;
  resolution: string;
  effectiveResolution: string;
  aspectRatio: string;
  quality: string;
  visualRealism: string;
  lampState: string;
  colorTemperatureKelvin: number;
  spaceType?: string;
  stylePresetId: string;
  designSchemeId?: string | null;
  lightingPreset: string;
  preservationMode: string;
  providerPreference: string;
  editInstruction: string | null;
  customPrompt: string | null;
  outputCount: number;
  advancedSettingsJson: string;
  idempotencyKey: string;
  requestHash: string;
  createdAt: string;
  updatedAt: string;
};

export type D1QueuedJobIdentity = {
  jobId: string;
  requestHash: string;
  created: boolean;
};

export type GenerationAdmissionPolicy = {
  requireMachineModeration?: boolean;
  moderationPolicyVersion?: string;
  dayStart?: string;
  dailyOutputLimit?: number;
  maxPendingOutputs?: number;
  requirePriceExpectation?: boolean;
  allowPrivateTestOverseas?: boolean;
  requireActiveVerifiedIdentity?: boolean; wechatAppId?: string;
  maxAttempts?: number;
  privateTestAutoCredit?: boolean;
  privateTestDailyUnlimited?: boolean;
};

/**
 * Inserts the public job and every billable output item in one D1 batch.
 * Existing idempotency rows are never repaired here; inconsistent historical
 * rows must be surfaced for reconciliation instead of silently re-queued.
 */
export async function createD1QueuedJobIdempotently(
  d1: D1Database,
  record: D1QueuedJobRecord,
  billing: GenerationBilling,
  policy: GenerationAdmissionPolicy = {},
  expectation?: GenerationPriceExpectation,
): Promise<D1QueuedJobIdentity> {
  assertQueueableRecord(record);
  validateGenerationBilling(billing);
  if ((policy.privateTestAutoCredit || policy.privateTestDailyUnlimited) && (record.ownerId !== PRIVATE_TEST_OWNER || !Number.isSafeInteger(record.outputCount) || record.outputCount < 1 || record.outputCount > 4)) {
    throw new ApiError(403, "PRIVATE_TEST_ACCOUNT_CONFLICT", "私测豁免仅限固定私测账号的1到4张任务。");
  }
  const dayStart = policy.dayStart ?? startOfTodayInShanghai();
  const maxPendingOutputs = boundedLimit(policy.maxPendingOutputs ?? 4, 1, 100, "maxPendingOutputs");
  const effectivePendingLimit = policy.privateTestAutoCredit ? 4 : maxPendingOutputs;
  const maxAttempts = boundedLimit(policy.maxAttempts ?? 3, 1, 8, "maxAttempts");
  const prior = await readIdentity(d1, record.ownerId, record.idempotencyKey);
  if (prior) {
    if (prior.requestHash === record.requestHash) {
      await assertD1QueuedJobItems(d1, { ...record, id: prior.jobId });
    }
    return { ...prior, created: false };
  }
  if (record.editInstruction?.startsWith("local-edit:v1:")) throw new ApiError(409, "LOCAL_EDIT_VERSION_RETIRED", "请刷新工作台后重新选择局部修改方式。");
  // Keep accepted historical requests replayable; retired workflows cannot create new work.
  if (record.workflowType === "floorplan") throw new ApiError(410, "WORKFLOW_RETIRED", "平面工作台已停用，请使用自助工作台。已有任务和图片仍可查看。");
  if (isOverseasImageModel(record.providerPreference) && !(policy.allowPrivateTestOverseas && record.ownerId === PRIVATE_TEST_OWNER)) throw new ApiError(403, "OVERSEAS_MODEL_UNAVAILABLE", "海外模型暂不对公众开放。");
  if (policy.requirePriceExpectation && !expectation) throw new ApiError(409, "PRICE_QUOTE_REQUIRED", "请先确认本次生成的最新积分价格。");
  if (expectation) assertGenerationPriceExpectation(billing, expectation, record.outputCount);

  const providerKey = imageModelProvider(record.providerPreference);
  const admissionId = `quota_${record.id}`;
  if (policy.requireMachineModeration && !/^tencent-20261006-v1:[a-f0-9]{16}$/.test(policy.moderationPolicyVersion ?? "")) throw new ApiError(503,"MODERATION_UNAVAILABLE","内容检查服务暂不可用。");
  const auditInputs = [record.sourceAssetId,record.referenceAssetId,record.maskAssetId,record.depthAssetId,record.normalAssetId,...(JSON.parse(record.additionalReferencesJson) as {assetId:string}[]).map(entry=>entry.assetId)].filter(Boolean);
  const customText = [record.customPrompt,userEditInstruction(record.editInstruction)].filter(Boolean).join("\n");
  const textSha = customText.trim() ? createHash("sha256").update(customText).digest("hex") : "";
  const insertAdmission = d1.prepare(
    `INSERT INTO generation_quota_admissions
      (id, job_id, owner_id, idempotency_key, request_hash, day_start, units,
       daily_limit_snapshot, pending_limit_snapshot)
     SELECT ?, ?, ?, ?, ?, ?, ?,
            0,
            CASE WHEN ? = 1 THEN ? ELSE COALESCE(limits.max_pending_outputs, ?) END
     FROM (SELECT 1) AS seed
     LEFT JOIN user_generation_limits AS limits ON limits.owner_id = ?
     WHERE (? = 0 OR EXISTS (SELECT 1 FROM users account WHERE account.id = ? AND account.status = 'ACTIVE' AND (EXISTS (SELECT 1 FROM auth_email_credentials credential WHERE credential.user_id=account.id AND credential.verified_at IS NOT NULL) OR (? <> '' AND EXISTS (SELECT 1 FROM auth_identities identity WHERE identity.user_id=account.id AND identity.provider='wechat' AND identity.provider_app_id=?)))))
       AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='ACTIVE')
       AND NOT EXISTS(SELECT 1 FROM json_each(?) required LEFT JOIN assets a ON a.id=required.value AND a.owner_id=? WHERE a.id IS NULL OR a.status<>'READY' OR a.moderation_status='REJECTED' OR a.sha256 IS NULL OR a.sanitization_version IS NOT 'canonical-image-v1' OR a.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM asset_moderation_evidence e JOIN assets previous ON previous.id=e.asset_id WHERE previous.owner_id=a.owner_id AND e.content_sha256=a.sha256 AND e.decision IN ('Review','Block')) OR (?=1 AND NOT EXISTS(SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=a.id AND e.content_sha256=a.sha256 AND e.policy_version=? AND e.decision='Pass')))
       AND (?='' OR (NOT EXISTS(SELECT 1 FROM text_moderation_evidence e WHERE e.owner_id=? AND e.content_sha256=? AND e.decision IN ('Review','Block')) AND (?=0 OR EXISTS(SELECT 1 FROM text_moderation_evidence e WHERE e.owner_id=? AND e.content_sha256=? AND e.policy_version=? AND e.decision='Pass'))))
       AND COALESCE(limits.enabled, 1) = 1
       AND COALESCE((
         SELECT COUNT(*)
         FROM generation_job_items AS pending
         WHERE pending.owner_id = ?
           AND pending.status NOT IN ('SUCCEEDED','FAILED','RECONCILIATION_REQUIRED','CANCELED')
       ), 0) + ? <= CASE WHEN ? = 1 THEN ? ELSE COALESCE(limits.max_pending_outputs, ?) END
     ON CONFLICT(owner_id, idempotency_key) DO NOTHING`,
  ).bind(
    admissionId,
    record.id,
    record.ownerId,
    record.idempotencyKey,
    record.requestHash,
    dayStart,
    record.outputCount,
    policy.privateTestAutoCredit ? 1 : 0,
    effectivePendingLimit,
    maxPendingOutputs,
    record.ownerId,
    policy.requireActiveVerifiedIdentity ? 1 : 0,
    record.ownerId, policy.wechatAppId ?? "", policy.wechatAppId ?? "",
    record.ownerId, JSON.stringify(auditInputs), record.ownerId, policy.requireMachineModeration ? 1 : 0, policy.moderationPolicyVersion ?? "", textSha, record.ownerId, textSha, policy.requireMachineModeration ? 1 : 0, record.ownerId, textSha, policy.moderationPolicyVersion ?? "",
    record.ownerId,
    record.outputCount,
    policy.privateTestAutoCredit ? 1 : 0,
    effectivePendingLimit,
    maxPendingOutputs,
  );
  const insertJob = d1
    .prepare(
      `INSERT INTO generation_jobs
        (id, owner_id, source_asset_id, reference_asset_id,
         additional_references_json, mask_asset_id, depth_asset_id,
         normal_asset_id, workflow_type, purpose, source_job_id,
         promoted_from_asset_id, resolution, effective_resolution,
         aspect_ratio, quality, visual_realism, lamp_state,
         color_temperature_kelvin, space_type, style_preset_id, design_scheme_id, lighting_preset,
         preservation_mode, provider_preference, edit_instruction,
         custom_prompt, output_count, advanced_settings_json,
         idempotency_key, request_hash, status, completed_output_count,
         created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM generation_quota_admissions
         WHERE id = ? AND job_id = ? AND owner_id = ?
           AND idempotency_key = ? AND request_hash = ?
       )
       ON CONFLICT(owner_id, idempotency_key) DO NOTHING`,
    )
    .bind(
      record.id,
      record.ownerId,
      record.sourceAssetId,
      record.referenceAssetId,
      record.additionalReferencesJson,
      record.maskAssetId,
      record.depthAssetId,
      record.normalAssetId,
      record.workflowType,
      record.purpose,
      record.sourceJobId,
      record.promotedFromAssetId,
      record.resolution,
      record.effectiveResolution,
      record.aspectRatio,
      record.quality,
      record.visualRealism,
      record.lampState,
      record.colorTemperatureKelvin,
      record.spaceType ?? "unspecified",
      record.stylePresetId,
      record.designSchemeId ?? null,
      record.lightingPreset,
      record.preservationMode,
      record.providerPreference,
      record.editInstruction,
      record.customPrompt,
      record.outputCount,
      record.advancedSettingsJson,
      record.idempotencyKey,
      record.requestHash,
      record.createdAt,
      record.updatedAt,
      admissionId,
      record.id,
      record.ownerId,
      record.idempotencyKey,
      record.requestHash,
    );
  const insertItems = Array.from({ length: record.outputCount }, (_, ordinal) =>
    d1
      .prepare(
        `INSERT OR IGNORE INTO generation_job_items
          (id, job_id, owner_id, ordinal, provider_preference, provider_key, max_attempts)
         SELECT ?, id, owner_id, ?, provider_preference, ?, ?
         FROM generation_jobs
         WHERE id = ? AND owner_id = ? AND idempotency_key = ?
           AND request_hash = ? AND provider_preference = ?
           AND output_count = ? AND status = 'QUEUED'
           AND NOT EXISTS (
             SELECT 1 FROM generation_job_outputs WHERE job_id = ?
           )`,
      )
      .bind(
        queueItemId(record.id, ordinal),
        ordinal,
        providerKey,
        maxAttempts,
        record.id,
        record.ownerId,
        record.idempotencyKey,
        record.requestHash,
        record.providerPreference,
        record.outputCount,
        record.id,
      ),
  );
  const retainInputs = d1.prepare(
    `UPDATE assets SET retention_expires_at = MAX(COALESCE(retention_expires_at, 0), ?)
     WHERE owner_id = ? AND status = 'READY' AND id IN (
       SELECT source_asset_id FROM generation_jobs WHERE id = ? AND owner_id = ?
       UNION SELECT reference_asset_id FROM generation_jobs WHERE id = ? AND owner_id = ?
       UNION SELECT mask_asset_id FROM generation_jobs WHERE id = ? AND owner_id = ?
       UNION SELECT depth_asset_id FROM generation_jobs WHERE id = ? AND owner_id = ?
       UNION SELECT normal_asset_id FROM generation_jobs WHERE id = ? AND owner_id = ?
       UNION SELECT json_extract(json_each.value, '$.assetId') FROM generation_jobs, json_each(generation_jobs.additional_references_json)
         WHERE generation_jobs.id = ? AND generation_jobs.owner_id = ?
     )`,
  ).bind(
    Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    record.ownerId,
    record.id, record.ownerId, record.id, record.ownerId, record.id, record.ownerId,
    record.id, record.ownerId, record.id, record.ownerId, record.id, record.ownerId,
  );

  const reserveCredits = Array.from({ length: record.outputCount }, (_, ordinal) => {
    const itemId = queueItemId(record.id, ordinal);
    const reservationId = `billing_${itemId}`;
    return d1.prepare(
      `INSERT OR IGNORE INTO credit_ledger_entries
        (id, owner_id, entry_type, amount, reservation_id, job_id, item_id,
         idempotency_key, reason_code, price_version, actor_id, request_id)
       SELECT ?, item.owner_id, 'RESERVE', ?, ?, item.job_id, item.id,
              ?, 'GENERATION_JOB_CREATED', ?, 'system', ?
       FROM generation_job_items AS item
       WHERE item.id = ? AND item.job_id = ? AND item.owner_id = ?
         AND item.execution_kind = 'provider'
         AND NOT EXISTS (
           SELECT 1 FROM credit_ledger_entries
           WHERE owner_id = item.owner_id AND reservation_id = ?
             AND entry_type = 'RESERVE'
         )`,
    ).bind(
      `ledger_reserve_${reservationId}`,
      billing.amountPerItem,
      reservationId,
      `reserve:${reservationId}`,
      billing.priceVersion,
      admissionId,
      itemId,
      record.id,
      record.ownerId,
      reservationId,
    );
  });

  const privateTestCredit = policy.privateTestAutoCredit ? d1.prepare(
    `INSERT OR IGNORE INTO credit_ledger_entries
       (id, owner_id, entry_type, amount, idempotency_key, reason_code, actor_id, request_id)
     SELECT ?, job.owner_id, 'CREDIT', ?, ?, 'PRIVATE_TEST_JOB_CREDIT', 'system', ?
     FROM generation_jobs AS job
     WHERE job.id = ? AND job.owner_id = ? AND job.idempotency_key = ? AND job.request_hash = ?
       AND EXISTS (SELECT 1 FROM generation_job_items WHERE job_id = job.id)`,
  ).bind(
    `ledger_credit_private_${record.id}`,
    billing.amountPerItem * record.outputCount,
    `private-test-job-credit:${record.id}`,
    `private-test-job:${record.id}`,
    record.id,
    record.ownerId,
    record.idempotencyKey,
    record.requestHash,
  ) : null;

  let results: D1Result<unknown>[];
  try {
    // Admission, job, items, private-test credit (if enabled), and reservations stay atomic.
    results = await d1.batch([insertAdmission, insertJob, retainInputs, ...insertItems, ...(privateTestCredit ? [privateTestCredit] : []), ...reserveCredits]);
  } catch (error) {
    if (isInsufficientCreditsError(error)) {
      throw new ApiError(402, "INSUFFICIENT_CREDITS", "积分余额不足，请充值后再试。");
    }
    throw error;
  }
  const identity = await readIdentity(d1, record.ownerId, record.idempotencyKey);
  if (!identity) {
    const admitted = await d1.prepare(
      "SELECT id FROM generation_quota_admissions WHERE id = ?",
    ).bind(admissionId).first<{ id: string }>();
    if (!admitted) {
      throw new ApiError(
        429,
        "GENERATION_LIMIT_REACHED",
        "待处理任务数量已达到上限，请等待当前任务完成后再试。",
      );
    }
    throw new ApiError(
      500,
      "QUEUE_JOB_CREATE_FAILED",
      "生成任务未能可靠写入持久队列。",
    );
  }
  const created = resultChanges(results[1]) === 1;
  if (created) {
    if (identity.jobId !== record.id || identity.requestHash !== record.requestHash) {
      throw new ApiError(
        409,
        "QUEUE_JOB_IDENTITY_CONFLICT",
        "生成任务的幂等身份不一致，已安全停止入队。",
      );
    }
  }
  if (created || identity.requestHash === record.requestHash) {
    await assertD1QueuedJobItems(d1, { ...record, id: identity.jobId }, created ? billing : undefined);
  }
  return { ...identity, created };
}

function boundedLimit(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`INVALID_${name}`);
  return value;
}

export async function assertD1QueuedJobItems(
  d1: D1Database,
  job: Pick<
    D1QueuedJobRecord,
    "id" | "ownerId" | "providerPreference" | "outputCount"
  >,
  billing?: GenerationBilling,
): Promise<void> {
  await new D1GenerationQueue(d1).assertItemsConsistent(job, billing);
}

function assertQueueableRecord(
  record: D1QueuedJobRecord,
): asserts record is D1QueuedJobRecord & {
  providerPreference: ImageModel;
} {
  if (!isImageModel(record.providerPreference)) {
    throw new ApiError(
      409,
      "UNSUPPORTED_QUEUE_PROVIDER",
      "该图片模型不支持进入国产生成队列。",
    );
  }
  if (
    !Number.isSafeInteger(record.outputCount) ||
    record.outputCount < 1 ||
    record.outputCount > MAX_OUTPUT_ITEMS
  ) {
    throw new ApiError(
      400,
      "INVALID_OUTPUT_COUNT",
      "任务的输出数量必须在 1 到 4 之间。",
    );
  }
}

async function readIdentity(
  d1: D1Database,
  ownerId: string,
  idempotencyKey: string,
): Promise<{ jobId: string; requestHash: string } | null> {
  const row = await d1
    .prepare(
      `SELECT id, request_hash
       FROM generation_jobs
       WHERE owner_id = ? AND idempotency_key = ?
       LIMIT 1`,
    )
    .bind(ownerId, idempotencyKey)
    .first<{ id: string; request_hash: string }>();
  return row ? { jobId: row.id, requestHash: row.request_hash } : null;
}

function resultChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}
