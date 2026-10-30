import type {
  GenerationAttemptState,
  GenerationExecutionKind,
  GenerationQueueItemStatus,
  JobStatus,
} from "@/db/schema";
import {
  assertQueueItemTransition,
  attemptStateForItemStatus,
  decideExpiredLease,
  retryDelaySeconds,
} from "@/lib/domain/generation-queue";
import {
  imageModelProvider,
  isImageModel,
} from "@/lib/domain/image-models";
import { ApiError } from "./api";
import { PRIVATE_TEST_OWNER } from "./private-test";
import {
  isInsufficientCreditsError,
  validateGenerationBilling,
  type GenerationBilling,
} from "./credit-ledger";

const ACTIVE_SQL = "'LEASED','PREPROCESSING','SUBMITTING','PERSISTING'";
const MAX_OUTPUT_ITEMS = 4;
export const JOB_AGGREGATE_ASSIGNMENTS = `SET completed_output_count = (
       SELECT COUNT(*) FROM generation_job_items
       WHERE generation_job_items.job_id = generation_jobs.id
         AND generation_job_items.status = 'SUCCEEDED'
     ),
     status = CASE
       WHEN NOT EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
       ) THEN 'QUEUED'
       WHEN NOT EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.status <> 'SUCCEEDED'
       ) THEN 'SUCCEEDED'
       WHEN EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.status = 'RECONCILIATION_REQUIRED'
       ) THEN 'VALIDATING'
       WHEN NOT EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.status NOT IN
             ('SUCCEEDED','FAILED','RECONCILIATION_REQUIRED','CANCELED')
       ) THEN CASE
         WHEN EXISTS (
           SELECT 1 FROM generation_job_items
           WHERE generation_job_items.job_id = generation_jobs.id
             AND generation_job_items.status = 'SUCCEEDED'
         ) THEN 'PARTIAL_SUCCEEDED'
         WHEN NOT EXISTS (
           SELECT 1 FROM generation_job_items
           WHERE generation_job_items.job_id = generation_jobs.id
             AND generation_job_items.status <> 'CANCELED'
         ) THEN 'CANCELED'
         ELSE 'FAILED'
       END
       WHEN EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.status = 'PERSISTING'
       ) THEN 'VALIDATING'
       WHEN EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.status = 'SUBMITTING'
       ) THEN 'GENERATING'
       WHEN EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.status IN ('LEASED','PREPROCESSING')
       ) THEN 'PREPROCESSING'
       ELSE 'QUEUED'
     END,
     provider = (
       SELECT attempt.provider
       FROM generation_job_items AS item
       JOIN generation_attempts AS attempt
         ON attempt.id = item.current_attempt_id
       WHERE item.job_id = generation_jobs.id
         AND attempt.provider IS NOT NULL
       ORDER BY item.ordinal
       LIMIT 1
     ),
     model = (
       SELECT attempt.model
       FROM generation_job_items AS item
       JOIN generation_attempts AS attempt
         ON attempt.id = item.current_attempt_id
       WHERE item.job_id = generation_jobs.id
         AND attempt.model IS NOT NULL
       ORDER BY item.ordinal
       LIMIT 1
     ),
     provider_request_id = (
       SELECT attempt.provider_request_id
       FROM generation_job_items AS item
       JOIN generation_attempts AS attempt
         ON attempt.id = item.current_attempt_id
       WHERE item.job_id = generation_jobs.id
         AND attempt.provider_request_id IS NOT NULL
       ORDER BY item.ordinal
       LIMIT 1
     ),
     error_code = (
       SELECT COALESCE(attempt.error_code, item.last_error_code)
       FROM generation_job_items AS item
       LEFT JOIN generation_attempts AS attempt
         ON attempt.id = item.current_attempt_id
       WHERE item.job_id = generation_jobs.id
         AND item.status IN ('FAILED','RECONCILIATION_REQUIRED')
         AND COALESCE(attempt.error_code, item.last_error_code) IS NOT NULL
       ORDER BY item.ordinal
       LIMIT 1
     ),
     error_message = (
       SELECT COALESCE(attempt.error_message, item.last_error_message)
       FROM generation_job_items AS item
       LEFT JOIN generation_attempts AS attempt
         ON attempt.id = item.current_attempt_id
       WHERE item.job_id = generation_jobs.id
         AND item.status IN ('FAILED','RECONCILIATION_REQUIRED')
         AND COALESCE(attempt.error_message, item.last_error_message) IS NOT NULL
       ORDER BY item.ordinal
       LIMIT 1
     ),
     error_retryable = (
       SELECT item.last_error_retryable
       FROM generation_job_items AS item
       WHERE item.job_id = generation_jobs.id
         AND item.status IN ('FAILED','RECONCILIATION_REQUIRED')
         AND item.last_error_retryable IS NOT NULL
       ORDER BY item.ordinal
       LIMIT 1
     ),
     started_at = CASE
       WHEN EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.attempt_count > 0
       ) THEN COALESCE(started_at, CURRENT_TIMESTAMP)
       ELSE started_at
     END,
     finished_at = CASE
       WHEN EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
       ) AND NOT EXISTS (
         SELECT 1 FROM generation_job_items
         WHERE generation_job_items.job_id = generation_jobs.id
           AND generation_job_items.status NOT IN ('SUCCEEDED','FAILED','CANCELED')
       ) THEN COALESCE(finished_at, CURRENT_TIMESTAMP)
       ELSE NULL
     END,
     updated_at = CURRENT_TIMESTAMP`;

export type GenerationQueueItem = {
  id: string;
  jobId: string;
  ownerId: string;
  ordinal: number;
  providerPreference: string;
  providerKey: string;
  executionKind: GenerationExecutionKind;
  status: GenerationQueueItemStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: number;
  leaseToken: string | null;
  leaseGeneration: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  heartbeatAt: number | null;
  currentAttemptId: string | null;
};

export type QueueFence = {
  itemId: string;
  leaseToken: string;
  leaseGeneration: number;
};

export type ClaimedQueueItem = {
  item: GenerationQueueItem;
  fence: QueueFence;
  attemptId: string;
};

export type QueueFenceSnapshot = {
  jobId: string;
  ownerId: string;
  ordinal: number;
  currentAttemptId: string | null;
  providerPreference: string;
  providerKey: string;
  executionKind: GenerationExecutionKind;
  itemStatus: GenerationQueueItemStatus;
  itemLeaseToken: string | null;
  leaseGeneration: number;
  leaseExpiresAt: number | null;
  leaseValid: boolean;
  attemptLeaseToken: string | null;
  attemptLeaseGeneration: number | null;
  attemptState: GenerationAttemptState | null;
  provider: string | null;
  model: string | null;
  providerAccountSlot: string | null;
  providerRequestId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ClaimQueueOptions = {
  workerId: string;
  claimRequestId: string;
  leaseSeconds?: number;
  ownerConcurrency?: number;
  providerConcurrency?: number;
  executionKind?: GenerationExecutionKind;
  targetItemId?: string;
  privateTest?: { ownerId: string; models: readonly string[] };
};

export type TransitionDetails = {
  provider?: string | null;
  model?: string | null;
  providerAccountSlot?: string | null;
  providerRequestId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorRetryable?: boolean | null;
};

type QueueItemRow = {
  id: string;
  job_id: string;
  owner_id: string;
  ordinal: number;
  provider_preference: string;
  provider_key: string;
  execution_kind: GenerationExecutionKind;
  status: GenerationQueueItemStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_generation: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  current_attempt_id: string | null;
};

type ExpiredQueueItemRow = Pick<
  QueueItemRow,
  | "id"
  | "job_id"
  | "status"
  | "attempt_count"
  | "max_attempts"
  | "lease_token"
  | "lease_generation"
  | "current_attempt_id"
>;

type ClaimRequestRow = QueueItemRow & {
  attempt_id: string;
  attempt_lease_token: string;
  attempt_lease_generation: number;
  claim_worker_id: string | null;
  lease_valid: number;
};

export class D1GenerationQueue {
  constructor(private readonly d1: D1Database) {}

  async materializeItems(jobId: string, billing: GenerationBilling): Promise<number> {
    validateGenerationBilling(billing);
    const job = await this.d1
      .prepare(
        "SELECT id, owner_id, provider_preference, output_count, status FROM generation_jobs WHERE id = ?",
      )
      .bind(jobId)
      .first<{
        id: string;
        owner_id: string;
        provider_preference: string;
        output_count: number;
        status: JobStatus;
      }>();
    if (!job) throw new ApiError(404, "JOB_NOT_FOUND", "没有找到这个生成任务。");
    if (!isImageModel(job.provider_preference)) {
      throw new ApiError(
        409,
        "UNSUPPORTED_QUEUE_PROVIDER",
        "该历史任务的图片模型不支持进入国产生成队列。",
      );
    }
    const providerKey = imageModelProvider(job.provider_preference);
    if (
      !Number.isSafeInteger(job.output_count) ||
      job.output_count < 1 ||
      job.output_count > MAX_OUTPUT_ITEMS
    ) {
      throw new ApiError(
        500,
        "INVALID_PERSISTED_OUTPUT_COUNT",
        "任务的输出数量无效，未加入生成队列。",
      );
    }

    const existingItems = await this.listItems(jobId);
    if (existingItems.length > 0) {
      assertMaterializedItems(existingItems, job, providerKey);
      await this.assertItemsConsistent({
        id: job.id,
        ownerId: job.owner_id,
        providerPreference: job.provider_preference,
        outputCount: job.output_count,
      }, billing);
      return 0;
    }
    if (job.status !== "QUEUED") {
      throw new ApiError(
        409,
        "JOB_NOT_QUEUEABLE",
        "只有尚未开始的排队任务可以首次加入生成队列。",
      );
    }
    const output = await this.d1
      .prepare(
        "SELECT COUNT(*) AS count FROM generation_job_outputs WHERE job_id = ?",
      )
      .bind(jobId)
      .first<{ count: number }>();
    if ((output?.count ?? 0) !== 0) {
      throw new ApiError(
        409,
        "JOB_ALREADY_HAS_OUTPUTS",
        "已有输出的任务不能重新加入生成队列。",
      );
    }

    const statements = Array.from({ length: job.output_count }, (_, ordinal) =>
      this.d1
        .prepare(
          `INSERT OR IGNORE INTO generation_job_items
            (id, job_id, owner_id, ordinal, provider_preference, provider_key)
           SELECT ?, id, owner_id, ?, provider_preference, ?
           FROM generation_jobs
           WHERE id = ? AND owner_id = ? AND provider_preference = ?
             AND status = 'QUEUED'
             AND NOT EXISTS (
               SELECT 1 FROM generation_job_outputs WHERE job_id = ?
             )`,
        )
        .bind(
          queueItemId(job.id, ordinal),
          ordinal,
          providerKey,
          job.id,
          job.owner_id,
          job.provider_preference,
          job.id,
        ),
    );
    const reserves = Array.from({ length: job.output_count }, (_, ordinal) => {
      const itemId = queueItemId(job.id, ordinal);
      const reservationId = `billing_${itemId}`;
      return this.d1.prepare(
        `INSERT OR IGNORE INTO credit_ledger_entries
          (id, owner_id, entry_type, amount, reservation_id, job_id, item_id,
           idempotency_key, reason_code, price_version, actor_id, request_id)
         SELECT ?, owner_id, 'RESERVE', ?, ?, job_id, id,
                ?, 'GENERATION_JOB_MATERIALIZED', ?, 'system', ?
         FROM generation_job_items AS item
         WHERE item.id = ? AND item.execution_kind = 'provider'
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
        `materialize:${job.id}`,
        itemId,
        reservationId,
      );
    });
    let results: D1Result<unknown>[];
    try {
      results = await this.d1.batch([...statements, ...reserves]);
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        throw new ApiError(402, "INSUFFICIENT_CREDITS", "积分余额不足，请充值后再试。");
      }
      throw error;
    }
    const created = results.slice(0, statements.length).reduce(
      (total, result) => total + resultChanges(result),
      0,
    );
    await this.assertItemsConsistent({
      id: job.id,
      ownerId: job.owner_id,
      providerPreference: job.provider_preference,
      outputCount: job.output_count,
    }, billing);
    return created;
  }

  async claimNextEligible(
    options: ClaimQueueOptions,
  ): Promise<ClaimedQueueItem | null> {
    const workerId = requireBoundedIdentifier(options.workerId, "workerId");
    const claimRequestId = requireBoundedIdentifier(
      options.claimRequestId,
      "claimRequestId",
    );
    const leaseSeconds = boundedPositiveInteger(options.leaseSeconds ?? 120, 30, 900, "leaseSeconds");
    const ownerConcurrency = boundedPositiveInteger(options.ownerConcurrency ?? 3, 1, 16, "ownerConcurrency");
    const providerConcurrency = boundedPositiveInteger(options.providerConcurrency ?? 1, 1, 32, "providerConcurrency");
    const executionKind = options.executionKind ?? "provider";
    if (executionKind !== "provider" && executionKind !== "acceptance") {
      throw new Error("INVALID_EXECUTION_KIND");
    }
    if (executionKind === "provider" && options.targetItemId !== undefined) {
      throw new Error("TARGET_ITEM_REQUIRES_ACCEPTANCE");
    }
    const targetItemId =
      executionKind === "acceptance"
        ? requireBoundedIdentifier(options.targetItemId ?? "", "targetItemId")
        : null;
    const privateTest = options.privateTest;
    const prior = await this.readClaimRequest(
      claimRequestId,
      workerId,
      executionKind,
      targetItemId,
    );
    if (prior !== undefined) return prior;
    const leaseToken = crypto.randomUUID();
    const attemptId = `attempt_${crypto.randomUUID()}`;

    const claim = this.d1
      .prepare(
        `UPDATE generation_job_items
         SET status = 'LEASED',
             attempt_count = attempt_count + 1,
             lease_token = ?,
             lease_generation = lease_generation + 1,
             lease_owner = ?,
             lease_expires_at = unixepoch() + ?,
             heartbeat_at = unixepoch(),
             current_attempt_id = ?,
             last_error_code = NULL,
             last_error_message = NULL,
             last_error_retryable = NULL,
             updated_at = unixepoch(),
             finished_at = NULL
         WHERE id = (
           SELECT candidate.id
           FROM generation_job_items AS candidate
           WHERE candidate.status IN ('QUEUED', 'RETRY_WAIT')
             AND candidate.execution_kind = ?
             AND (? IS NULL OR candidate.id = ?)
             AND (? = 0 OR (
               candidate.owner_id = ?
               AND candidate.provider_preference IN (SELECT value FROM json_each(?))
             ))
             AND (candidate.execution_kind = 'acceptance' OR EXISTS (
               SELECT 1 FROM credit_ledger_entries AS reserved
               WHERE reserved.owner_id = candidate.owner_id
                 AND reserved.job_id = candidate.job_id
                 AND reserved.item_id = candidate.id
                 AND reserved.reservation_id = candidate.billing_reservation_id
                 AND reserved.entry_type = 'RESERVE'
                 AND NOT EXISTS (
                   SELECT 1 FROM credit_ledger_entries AS terminal
                   WHERE terminal.reservation_id = reserved.reservation_id
                     AND terminal.entry_type IN ('SETTLE','RELEASE')
                 )
             ))
             AND EXISTS (
               SELECT 1 FROM generation_jobs AS candidate_job
               WHERE candidate_job.id = candidate.job_id
                 AND (candidate_job.status = 'QUEUED' OR (? = 1 AND candidate_job.status = 'VALIDATING' AND EXISTS (
                   SELECT 1 FROM generation_job_items AS recon
                   WHERE recon.job_id = candidate_job.id AND recon.status = 'RECONCILIATION_REQUIRED'
                 )))
             )
             AND candidate.next_attempt_at <= unixepoch()
             AND candidate.attempt_count < candidate.max_attempts
             AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at <= unixepoch())
             AND COALESCE((
               SELECT enabled FROM user_generation_limits
               WHERE owner_id = candidate.owner_id
             ), 1) = 1
             AND NOT EXISTS (
               SELECT 1 FROM users AS account
               WHERE account.id = candidate.owner_id AND account.status <> 'ACTIVE'
             )
             AND (
               SELECT COUNT(*)
               FROM generation_job_items AS active_owner
               WHERE active_owner.owner_id = candidate.owner_id
                 AND active_owner.status IN (${ACTIVE_SQL})
                 AND active_owner.lease_expires_at > unixepoch()
             ) < MIN(?, COALESCE((
               SELECT active_concurrency_limit FROM user_generation_limits
               WHERE owner_id = candidate.owner_id
             ), ?))
             AND (
               SELECT COUNT(*)
               FROM generation_job_items AS active_provider
               WHERE active_provider.provider_key = candidate.provider_key
                 AND active_provider.status IN (${ACTIVE_SQL})
                 AND active_provider.lease_expires_at > unixepoch()
             ) < ?
           ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
           LIMIT 1
         )
           AND status IN ('QUEUED', 'RETRY_WAIT')
           AND next_attempt_at <= unixepoch()
           AND attempt_count < max_attempts
           AND (lease_expires_at IS NULL OR lease_expires_at <= unixepoch())
         RETURNING id, job_id, owner_id, ordinal, provider_preference, provider_key, execution_kind, status,
                   attempt_count, max_attempts, next_attempt_at, lease_token,
                   lease_generation, lease_owner, lease_expires_at, heartbeat_at,
                   current_attempt_id`,
      )
      .bind(
        leaseToken,
        workerId,
        leaseSeconds,
        attemptId,
        executionKind,
        targetItemId,
        targetItemId,
        privateTest ? 1 : 0,
        privateTest?.ownerId ?? "",
        JSON.stringify(privateTest?.models ?? []),
        privateTest?.ownerId === PRIVATE_TEST_OWNER ? 1 : 0,
        ownerConcurrency,
        ownerConcurrency,
        providerConcurrency,
      );
    const createAttempt = this.d1
      .prepare(
        `INSERT INTO generation_attempts
          (id, item_id, attempt_no, lease_token, lease_generation,
           claim_request_id, claim_worker_id, state, started_at, heartbeat_at)
         SELECT ?, id, attempt_count, lease_token, lease_generation, ?, ?, 'STARTED',
                unixepoch(), unixepoch()
         FROM generation_job_items
         WHERE current_attempt_id = ? AND lease_token = ?`,
      )
      .bind(
        attemptId,
        claimRequestId,
        workerId,
        attemptId,
        leaseToken,
      );

    let claimResult: D1Result<QueueItemRow> | undefined;
    try {
      [claimResult] = await this.d1.batch<QueueItemRow>([
        claim,
        createAttempt,
        this.jobAggregateByCurrentAttemptStatement(attemptId),
      ]);
    } catch (error) {
      const recovered = await this.readClaimRequest(
        claimRequestId,
        workerId,
        executionKind,
        targetItemId,
      );
      if (recovered !== undefined) return recovered;
      throw error;
    }
    const row = claimResult?.results?.[0];
    if (!row) return null;
    const item = mapQueueItem(row);
    if (!item.leaseToken || !item.currentAttemptId) {
      throw new Error("Claimed queue item is missing its fence");
    }
    return {
      item,
      attemptId: item.currentAttemptId,
      fence: {
        itemId: item.id,
        leaseToken: item.leaseToken,
        leaseGeneration: item.leaseGeneration,
      },
    };
  }

  async heartbeat(fence: QueueFence, leaseSeconds = 120): Promise<boolean> {
    validateFence(fence);
    const boundedLease = boundedPositiveInteger(leaseSeconds, 30, 900, "leaseSeconds");
    const [attemptResult, itemResult] = await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE generation_attempts
           SET heartbeat_at = unixepoch()
           WHERE id = (
             SELECT current_attempt_id FROM generation_job_items
             WHERE id = ? AND lease_token = ? AND lease_generation = ?
               AND status IN (${ACTIVE_SQL})
               AND lease_expires_at > unixepoch()
           )`,
        )
        .bind(fence.itemId, fence.leaseToken, fence.leaseGeneration),
      this.d1
        .prepare(
          `UPDATE generation_job_items
           SET heartbeat_at = unixepoch(),
               lease_expires_at = unixepoch() + ?,
               updated_at = unixepoch()
           WHERE id = ? AND lease_token = ? AND lease_generation = ?
             AND status IN (${ACTIVE_SQL})
             AND lease_expires_at > unixepoch()
             AND EXISTS (
               SELECT 1 FROM generation_attempts
               WHERE id = generation_job_items.current_attempt_id
                 AND lease_token = generation_job_items.lease_token
                 AND lease_generation = generation_job_items.lease_generation
             )`,
        )
        .bind(
          boundedLease,
          fence.itemId,
          fence.leaseToken,
          fence.leaseGeneration,
        ),
      this.jobAggregateByItemStatement(fence.itemId),
    ]);
    return resultChanges(itemResult) === 1 && resultChanges(attemptResult) === 1;
  }

  async transition(
    fence: QueueFence,
    from: GenerationQueueItemStatus,
    to: GenerationQueueItemStatus,
    details: TransitionDetails = {},
  ): Promise<boolean> {
    validateFence(fence);
    assertQueueItemTransition(from, to);
    if (to === "RETRY_WAIT" || to === "FAILED") {
      throw new Error("USE_SCHEDULE_SAFE_RETRY");
    }
    const attemptState = attemptStateForItemStatus(to);
    const terminal = to === "SUCCEEDED" || to === "RECONCILIATION_REQUIRED" || to === "CANCELED";
    const providerStarted = to === "SUBMITTING" ? "unixepoch()" : "provider_started_at";
    const providerResponded = to === "PERSISTING" ? "unixepoch()" : "provider_responded_at";
    const attemptFinished = terminal ? "unixepoch()" : "finished_at";
    const itemFinished = terminal ? "unixepoch()" : "finished_at";

    const attemptUpdate = this.d1
      .prepare(
         `UPDATE generation_attempts
         SET state = ?,
             provider = COALESCE(provider, ?),
             model = COALESCE(model, ?),
             provider_account_slot = COALESCE(provider_account_slot, ?),
             provider_request_id = COALESCE(provider_request_id, ?),
             error_code = ?,
             error_message = ?,
             provider_started_at = ${providerStarted},
             provider_responded_at = ${providerResponded},
             heartbeat_at = unixepoch(),
             finished_at = ${attemptFinished}
         WHERE id = (
           SELECT current_attempt_id FROM generation_job_items
           WHERE id = ? AND lease_token = ? AND lease_generation = ?
             AND status = ? AND lease_expires_at > unixepoch()
         )
           AND (? IS NULL OR provider IS NULL OR provider = ?)
           AND (? IS NULL OR model IS NULL OR model = ?)
           AND (? IS NULL OR provider_account_slot IS NULL OR provider_account_slot = ?)
           AND (? IS NULL OR provider_request_id IS NULL OR provider_request_id = ?)`,
      )
      .bind(
        attemptState,
        details.provider ?? null,
        details.model ?? null,
        details.providerAccountSlot ?? null,
        details.providerRequestId ?? null,
        details.errorCode ?? null,
        details.errorMessage ?? null,
        fence.itemId,
        fence.leaseToken,
        fence.leaseGeneration,
        from,
        details.provider ?? null,
        details.provider ?? null,
        details.model ?? null,
        details.model ?? null,
        details.providerAccountSlot ?? null,
        details.providerAccountSlot ?? null,
        details.providerRequestId ?? null,
        details.providerRequestId ?? null,
      );
    const itemUpdate = this.d1
      .prepare(
        `UPDATE generation_job_items
         SET status = ?,
             last_error_code = ?,
             last_error_message = ?,
             last_error_retryable = ?,
             heartbeat_at = unixepoch(),
             updated_at = unixepoch(),
             finished_at = ${itemFinished},
             lease_token = CASE WHEN ? THEN NULL ELSE lease_token END,
             lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
             lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END
         WHERE id = ? AND lease_token = ? AND lease_generation = ?
           AND status = ? AND lease_expires_at > unixepoch()
           AND EXISTS (
             SELECT 1 FROM generation_attempts
             WHERE id = generation_job_items.current_attempt_id
               AND lease_token = generation_job_items.lease_token
               AND lease_generation = generation_job_items.lease_generation
               AND (? IS NULL OR provider IS NULL OR provider = ?)
               AND (? IS NULL OR model IS NULL OR model = ?)
               AND (? IS NULL OR provider_account_slot IS NULL OR provider_account_slot = ?)
               AND (? IS NULL OR provider_request_id IS NULL OR provider_request_id = ?)
           )`,
      )
      .bind(
        to,
        details.errorCode ?? null,
        details.errorMessage ?? null,
        details.errorRetryable == null ? null : details.errorRetryable ? 1 : 0,
        terminal ? 1 : 0,
        terminal ? 1 : 0,
        terminal ? 1 : 0,
        fence.itemId,
        fence.leaseToken,
        fence.leaseGeneration,
        from,
        details.provider ?? null,
        details.provider ?? null,
        details.model ?? null,
        details.model ?? null,
        details.providerAccountSlot ?? null,
        details.providerAccountSlot ?? null,
        details.providerRequestId ?? null,
        details.providerRequestId ?? null,
      );
    const [attemptResult, itemResult] = await this.d1.batch([
      attemptUpdate,
      itemUpdate,
      this.jobAggregateByItemStatement(fence.itemId),
    ]);
    return resultChanges(attemptResult) === 1 && resultChanges(itemResult) === 1;
  }

  async scheduleSafeRetry(
    fence: QueueFence,
    from: "LEASED" | "PREPROCESSING",
    details: Required<Pick<TransitionDetails, "errorCode" | "errorMessage">> &
      Pick<TransitionDetails, "errorRetryable">,
    random = Math.random(),
  ): Promise<"retry" | "failed" | "stale"> {
    validateFence(fence);
    const current = await this.readFencedItem(fence, from);
    if (!current) return "stale";
    const hasBudget =
      details.errorRetryable !== false &&
      current.attemptCount < current.maxAttempts;
    const nextStatus: GenerationQueueItemStatus = hasBudget ? "RETRY_WAIT" : "FAILED";
    const delay = hasBudget ? retryDelaySeconds(current.attemptCount, random) : 0;
    const attemptState: GenerationAttemptState = "FAILED";
    const [attemptResult, itemResult] = await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE generation_attempts
           SET state = ?, retry_class = ?, error_code = ?,
               error_message = ?, heartbeat_at = unixepoch(), finished_at = unixepoch()
           WHERE id = (
             SELECT current_attempt_id FROM generation_job_items
             WHERE id = ? AND lease_token = ? AND lease_generation = ?
               AND status = ? AND lease_expires_at > unixepoch()
           )`,
        )
        .bind(
          attemptState,
          details.errorRetryable === false ? "not-retryable" : "safe-before-provider",
          details.errorCode,
          details.errorMessage,
          fence.itemId,
          fence.leaseToken,
          fence.leaseGeneration,
          from,
        ),
      this.d1
        .prepare(
          `UPDATE generation_job_items
           SET status = ?, next_attempt_at = unixepoch() + ?,
               last_error_code = ?, last_error_message = ?,
               last_error_retryable = ?, updated_at = unixepoch(),
               finished_at = CASE WHEN ? THEN unixepoch() ELSE NULL END,
               lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND lease_token = ? AND lease_generation = ?
             AND status = ? AND lease_expires_at > unixepoch()
             AND EXISTS (
               SELECT 1 FROM generation_attempts
               WHERE id = generation_job_items.current_attempt_id
                 AND lease_token = generation_job_items.lease_token
                 AND lease_generation = generation_job_items.lease_generation
             )`,
        )
        .bind(
          nextStatus,
          delay,
          details.errorCode,
          details.errorMessage,
          details.errorRetryable === false ? 0 : 1,
          hasBudget ? 0 : 1,
          fence.itemId,
          fence.leaseToken,
          fence.leaseGeneration,
          from,
        ),
      this.jobAggregateByItemStatement(fence.itemId),
    ]);
    if (resultChanges(attemptResult) !== 1 || resultChanges(itemResult) !== 1) {
      return "stale";
    }
    return hasBudget ? "retry" : "failed";
  }

  async recoverExpiredLeases(
    limit = 50,
    random = Math.random,
    executionKind: GenerationExecutionKind = "provider",
    targetAcceptanceItemId?: string,
  ): Promise<{ retried: number; failed: number; reconciliationRequired: number }> {
    const boundedLimit = boundedPositiveInteger(limit, 1, 100, "limit");
    if (
      (executionKind === "acceptance") !==
      (targetAcceptanceItemId !== undefined)
    ) {
      throw new Error("INVALID_SWEEP_SCOPE");
    }
    const rows = await this.d1
      .prepare(
        `SELECT id, job_id, status, attempt_count, max_attempts, lease_token,
                lease_generation, current_attempt_id
         FROM generation_job_items
         WHERE status IN (${ACTIVE_SQL}) AND lease_expires_at <= unixepoch()
           AND execution_kind = ?
           AND NOT (status='PERSISTING' AND EXISTS(SELECT 1 FROM generation_output_commits oc WHERE oc.item_id=generation_job_items.id AND oc.attempt_id=generation_job_items.current_attempt_id AND oc.lease_generation=generation_job_items.lease_generation AND oc.state='OBJECT_STORED'))
           AND (? IS NULL OR id = ?)
         ORDER BY lease_expires_at, id
         LIMIT ?`,
      )
      .bind(
        executionKind,
        targetAcceptanceItemId ?? null,
        targetAcceptanceItemId ?? null,
        boundedLimit,
      )
      .all<ExpiredQueueItemRow>();
    const summary = { retried: 0, failed: 0, reconciliationRequired: 0 };

    for (const row of rows.results ?? []) {
      if (!row.lease_token || !row.current_attempt_id) continue;
      const decision = decideExpiredLease({
        status: row.status,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
      });
      if (decision === "ignore") continue;
      const nextStatus: GenerationQueueItemStatus =
        decision === "retry"
          ? "RETRY_WAIT"
          : decision === "reconcile"
            ? "RECONCILIATION_REQUIRED"
            : "FAILED";
      const delay = decision === "retry" ? retryDelaySeconds(row.attempt_count, random()) : 0;
      const attemptState: GenerationAttemptState =
        decision === "reconcile" ? "AMBIGUOUS" : "FAILED";
      const retryClass =
        decision === "retry" ? "safe-before-provider" : decision === "reconcile" ? "ambiguous-after-provider" : "attempts-exhausted";
      const errorCode =
        decision === "reconcile" ? "AMBIGUOUS_PROVIDER_OUTCOME" : decision === "retry" ? "LEASE_EXPIRED_BEFORE_PROVIDER" : "QUEUE_ATTEMPTS_EXHAUSTED";
      const errorMessage =
        decision === "reconcile"
          ? "供应商请求阶段中断，结果和计费状态需要人工核对。"
          : decision === "retry"
            ? "任务在调用供应商前中断，已安排安全重试。"
            : "任务在调用供应商前多次中断，已停止重试。";
      const [attemptResult, itemResult] = await this.d1.batch([
        this.d1
          .prepare(
            `UPDATE generation_attempts
             SET state = ?, retry_class = ?, error_code = ?, error_message = ?,
                 finished_at = unixepoch()
             WHERE id = ? AND lease_token = ? AND lease_generation = ?
               AND EXISTS (
                 SELECT 1 FROM generation_job_items
                 WHERE id = ?
                   AND current_attempt_id = generation_attempts.id
                   AND lease_token = generation_attempts.lease_token
                   AND lease_generation = generation_attempts.lease_generation
                   AND status = ? AND lease_expires_at <= unixepoch()
                   AND NOT (status='PERSISTING' AND EXISTS(SELECT 1 FROM generation_output_commits oc WHERE oc.item_id=generation_job_items.id AND oc.attempt_id=generation_job_items.current_attempt_id AND oc.lease_generation=generation_job_items.lease_generation AND oc.state='OBJECT_STORED'))
               )`,
          )
          .bind(
            attemptState,
            retryClass,
            errorCode,
            errorMessage,
            row.current_attempt_id,
            row.lease_token,
            row.lease_generation,
            row.id,
            row.status,
          ),
        this.d1
          .prepare(
            `UPDATE generation_job_items
             SET status = ?, next_attempt_at = unixepoch() + ?,
                 last_error_code = ?, last_error_message = ?,
                 last_error_retryable = ?, updated_at = unixepoch(),
                 finished_at = CASE WHEN ? THEN NULL ELSE unixepoch() END,
                 lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ? AND lease_token = ? AND lease_generation = ?
               AND status = ? AND lease_expires_at <= unixepoch()
                   AND NOT (status='PERSISTING' AND EXISTS(SELECT 1 FROM generation_output_commits oc WHERE oc.item_id=generation_job_items.id AND oc.attempt_id=generation_job_items.current_attempt_id AND oc.lease_generation=generation_job_items.lease_generation AND oc.state='OBJECT_STORED'))
               AND EXISTS (
                 SELECT 1 FROM generation_attempts
                 WHERE id = generation_job_items.current_attempt_id
                   AND lease_token = generation_job_items.lease_token
                   AND lease_generation = generation_job_items.lease_generation
               )`,
          )
          .bind(
            nextStatus,
            delay,
            errorCode,
            errorMessage,
            decision === "retry" ? 1 : 0,
            decision === "retry" ? 1 : 0,
            row.id,
            row.lease_token,
            row.lease_generation,
            row.status,
          ),
        this.jobAggregateByItemStatement(row.id),
      ]);
      if (resultChanges(attemptResult) !== 1 || resultChanges(itemResult) !== 1) {
        continue;
      }
      if (decision === "retry") summary.retried += 1;
      else if (decision === "reconcile") summary.reconciliationRequired += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  async listItems(jobId: string): Promise<GenerationQueueItem[]> {
    const rows = await this.d1
      .prepare(
        `SELECT id, job_id, owner_id, ordinal, provider_preference, provider_key, execution_kind, status,
                attempt_count, max_attempts, next_attempt_at, lease_token,
                lease_generation, lease_owner, lease_expires_at, heartbeat_at,
                current_attempt_id
         FROM generation_job_items WHERE job_id = ? ORDER BY ordinal`,
      )
      .bind(jobId)
      .all<QueueItemRow>();
    return (rows.results ?? []).map(mapQueueItem);
  }

  async assertItemsConsistent(job: {
    id: string;
    ownerId: string;
    providerPreference: string;
    outputCount: number;
  }, billing?: GenerationBilling): Promise<void> {
    if (!isImageModel(job.providerPreference)) {
      throw new ApiError(
        409,
        "UNSUPPORTED_QUEUE_PROVIDER",
        "该图片模型不支持进入国产生成队列。",
      );
    }
    assertMaterializedItems(
      await this.listItems(job.id),
      {
        id: job.id,
        owner_id: job.ownerId,
        provider_preference: job.providerPreference,
        output_count: job.outputCount,
      },
      imageModelProvider(job.providerPreference),
    );
    const row = await this.d1.prepare(
      `SELECT COUNT(*) AS count
       FROM generation_job_items AS item
       JOIN credit_ledger_entries AS reserved
         ON reserved.reservation_id = item.billing_reservation_id
        AND reserved.entry_type = 'RESERVE'
       WHERE item.job_id = ? AND item.owner_id = ? AND item.execution_kind = 'provider'
         AND reserved.owner_id = item.owner_id AND reserved.job_id = item.job_id
         AND reserved.item_id = item.id
         AND (? IS NULL OR reserved.amount = ?)
         AND (? IS NULL OR reserved.price_version = ?)
         AND (
           (item.status = 'SUCCEEDED' AND EXISTS (
             SELECT 1 FROM credit_ledger_entries AS settled
             WHERE settled.reservation_id = reserved.reservation_id
               AND settled.entry_type = 'SETTLE'
           ))
           OR (item.status = 'FAILED' AND EXISTS (
             SELECT 1 FROM credit_ledger_entries AS released
             WHERE released.reservation_id = reserved.reservation_id
               AND released.entry_type = 'RELEASE'
           ))
           OR (item.status NOT IN ('SUCCEEDED','FAILED','CANCELED') AND NOT EXISTS (
             SELECT 1 FROM credit_ledger_entries AS terminal
             WHERE terminal.reservation_id = reserved.reservation_id
               AND terminal.entry_type IN ('SETTLE','RELEASE')
           ))
         )`,
    ).bind(
      job.id,
      job.ownerId,
      billing?.amountPerItem ?? null,
      billing?.amountPerItem ?? null,
      billing?.priceVersion ?? null,
      billing?.priceVersion ?? null,
    ).first<{ count: number }>();
    if ((row?.count ?? 0) !== job.outputCount) {
      throw new ApiError(409, "QUEUE_BILLING_INCONSISTENT", "任务的积分预扣记录不完整或不一致。");
    }
  }

  async inspectFence(fence: QueueFence): Promise<QueueFenceSnapshot | null> {
    validateFence(fence);
    const row = await this.d1
      .prepare(
        `SELECT item.job_id, item.owner_id, item.ordinal, item.current_attempt_id,
                item.provider_preference, item.provider_key, item.execution_kind,
                item.status AS item_status,
                item.lease_token AS item_lease_token,
                item.lease_generation, item.lease_expires_at,
                CASE WHEN item.lease_expires_at > unixepoch() THEN 1 ELSE 0 END AS lease_valid,
                attempt.lease_token AS attempt_lease_token,
                attempt.lease_generation AS attempt_lease_generation,
                attempt.state AS attempt_state,
                attempt.provider, attempt.model, attempt.provider_account_slot,
                attempt.provider_request_id, attempt.error_code, attempt.error_message
         FROM generation_job_items AS item
         LEFT JOIN generation_attempts AS attempt
           ON attempt.id = item.current_attempt_id
         WHERE item.id = ?`,
      )
      .bind(fence.itemId)
      .first<{
        job_id: string;
        owner_id: string;
        ordinal: number;
        current_attempt_id: string | null;
        provider_preference: string;
        provider_key: string;
        execution_kind: GenerationExecutionKind;
        item_status: GenerationQueueItemStatus;
        item_lease_token: string | null;
        lease_generation: number;
        lease_expires_at: number | null;
        lease_valid: number;
        attempt_lease_token: string | null;
        attempt_lease_generation: number | null;
        attempt_state: GenerationAttemptState | null;
        provider: string | null;
        model: string | null;
        provider_account_slot: string | null;
        provider_request_id: string | null;
        error_code: string | null;
        error_message: string | null;
      }>();
    if (!row) return null;
    return {
      jobId: row.job_id,
      ownerId: row.owner_id,
      ordinal: row.ordinal,
      currentAttemptId: row.current_attempt_id,
      providerPreference: row.provider_preference,
      providerKey: row.provider_key,
      executionKind: row.execution_kind,
      itemStatus: row.item_status,
      itemLeaseToken: row.item_lease_token,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at,
      leaseValid: row.lease_valid === 1,
      attemptLeaseToken: row.attempt_lease_token,
      attemptLeaseGeneration: row.attempt_lease_generation,
      attemptState: row.attempt_state,
      provider: row.provider,
      model: row.model,
      providerAccountSlot: row.provider_account_slot,
      providerRequestId: row.provider_request_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    };
  }

  async refreshJobAggregate(
    jobId: string,
  ): Promise<{ status: JobStatus; completedOutputCount: number } | null> {
    requireBoundedIdentifier(jobId, "jobId");
    const row = await this.d1
      .prepare(
        `UPDATE generation_jobs ${JOB_AGGREGATE_ASSIGNMENTS}
         WHERE id = ?
         RETURNING status, completed_output_count`,
      )
      .bind(jobId)
      .first<{ status: JobStatus; completed_output_count: number }>();
    return row
      ? {
          status: row.status,
          completedOutputCount: row.completed_output_count,
        }
      : null;
  }

  private async readClaimRequest(
    claimRequestId: string,
    workerId: string,
    executionKind: GenerationExecutionKind,
    targetItemId: string | null,
  ): Promise<ClaimedQueueItem | null | undefined> {
    const row = await this.d1
      .prepare(
        `SELECT item.id, item.job_id, item.owner_id, item.ordinal,
                item.provider_preference, item.provider_key, item.execution_kind, item.status,
                item.attempt_count, item.max_attempts, item.next_attempt_at,
                item.lease_token, item.lease_generation, item.lease_owner,
                item.lease_expires_at, item.heartbeat_at,
                item.current_attempt_id, attempt.id AS attempt_id,
                attempt.lease_token AS attempt_lease_token,
                attempt.lease_generation AS attempt_lease_generation,
                attempt.claim_worker_id,
                CASE WHEN item.lease_expires_at > unixepoch() THEN 1 ELSE 0 END AS lease_valid
         FROM generation_attempts AS attempt
         JOIN generation_job_items AS item ON item.id = attempt.item_id
         WHERE attempt.claim_request_id = ?`,
      )
      .bind(claimRequestId)
      .first<ClaimRequestRow>();
    if (!row) return undefined;
    if (row.claim_worker_id !== workerId) {
      throw new ApiError(
        409,
        "CLAIM_REQUEST_CONFLICT",
        "这个领取请求标识已经由另一工作进程使用。",
      );
    }
    if (row.execution_kind !== executionKind) {
      throw new ApiError(
        409,
        "CLAIM_REQUEST_CONFLICT",
        "这个领取请求标识已经用于另一种执行任务。",
      );
    }
    if (targetItemId !== null && row.id !== targetItemId) {
      throw new ApiError(
        409,
        "CLAIM_REQUEST_CONFLICT",
        "这个领取请求标识已经用于另一项验收任务。",
      );
    }
    if (
      row.current_attempt_id !== row.attempt_id ||
      row.lease_token !== row.attempt_lease_token ||
      row.lease_generation !== row.attempt_lease_generation ||
      row.lease_owner !== workerId ||
      row.lease_valid !== 1 ||
      !["LEASED", "PREPROCESSING", "SUBMITTING", "PERSISTING"].includes(
        row.status,
      )
    ) {
      return null;
    }
    const item = mapQueueItem(row);
    if (!item.leaseToken) return null;
    return {
      item,
      attemptId: row.attempt_id,
      fence: {
        itemId: item.id,
        leaseToken: item.leaseToken,
        leaseGeneration: item.leaseGeneration,
      },
    };
  }

  private jobAggregateByItemStatement(itemId: string) {
    return this.d1
      .prepare(
        `UPDATE generation_jobs ${JOB_AGGREGATE_ASSIGNMENTS}
         WHERE id = (
           SELECT job_id FROM generation_job_items WHERE id = ?
         )`,
      )
      .bind(itemId);
  }

  private jobAggregateByCurrentAttemptStatement(attemptId: string) {
    return this.d1
      .prepare(
        `UPDATE generation_jobs ${JOB_AGGREGATE_ASSIGNMENTS}
         WHERE id = (
           SELECT job_id FROM generation_job_items
           WHERE current_attempt_id = ?
         )`,
      )
      .bind(attemptId);
  }

  private async readFencedItem(
    fence: QueueFence,
    status: GenerationQueueItemStatus,
  ): Promise<GenerationQueueItem | null> {
    const row = await this.d1
      .prepare(
        `SELECT id, job_id, owner_id, ordinal, provider_preference, provider_key, execution_kind, status,
                attempt_count, max_attempts, next_attempt_at, lease_token,
                lease_generation, lease_owner, lease_expires_at, heartbeat_at,
                current_attempt_id
         FROM generation_job_items
         WHERE id = ? AND lease_token = ? AND lease_generation = ?
           AND status = ? AND lease_expires_at > unixepoch()`,
      )
      .bind(
        fence.itemId,
        fence.leaseToken,
        fence.leaseGeneration,
        status,
      )
      .first<QueueItemRow>();
    return row ? mapQueueItem(row) : null;
  }
}

function assertMaterializedItems(
  items: readonly GenerationQueueItem[],
  job: {
    id: string;
    owner_id: string;
    provider_preference: string;
    output_count: number;
  },
  providerKey: string,
): void {
  const consistent =
    items.length === job.output_count &&
    items.every(
      (item, ordinal) =>
        item.id === queueItemId(job.id, ordinal) &&
        item.jobId === job.id &&
        item.ownerId === job.owner_id &&
        item.ordinal === ordinal &&
        item.providerPreference === job.provider_preference &&
        item.providerKey === providerKey &&
        item.executionKind === "provider",
    );
  if (!consistent) {
    throw new ApiError(
      409,
      "QUEUE_ITEMS_INCONSISTENT",
      "任务的持久队列条目不完整或冻结配置不一致。",
    );
  }
}

export function queueItemId(jobId: string, ordinal: number): string {
  if (
    !/^[A-Za-z0-9_-]{1,110}$/u.test(jobId) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= MAX_OUTPUT_ITEMS
  ) {
    throw new Error("INVALID_QUEUE_ITEM_ID");
  }
  return `qitem_${jobId}_${ordinal}`;
}

function mapQueueItem(row: QueueItemRow): GenerationQueueItem {
  return {
    id: row.id,
    jobId: row.job_id,
    ownerId: row.owner_id,
    ordinal: row.ordinal,
    providerPreference: row.provider_preference,
    providerKey: row.provider_key,
    executionKind: row.execution_kind,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseGeneration: row.lease_generation,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    currentAttemptId: row.current_attempt_id,
  };
}

function validateFence(fence: QueueFence): void {
  requireBoundedIdentifier(fence.itemId, "itemId");
  requireBoundedIdentifier(fence.leaseToken, "leaseToken");
  if (!Number.isSafeInteger(fence.leaseGeneration) || fence.leaseGeneration < 1) {
    throw new Error("INVALID_QUEUE_FENCE");
  }
}

function requireBoundedIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9:_-]{1,128}$/u.test(value)
  ) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function boundedPositiveInteger(
  value: number,
  min: number,
  max: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function resultChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}
