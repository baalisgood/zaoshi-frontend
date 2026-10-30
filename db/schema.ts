import { sql } from "drizzle-orm";
import {
  check,
  primaryKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export type AssetKind =
  | "source"
  | "reference"
  | "mask"
  | "output"
  | "depth"
  | "normal"
  | "floorplan";
export type AssetStatus = "PENDING" | "READY" | "DELETED";
export type AssetModerationStatus = "UNREVIEWED" | "PENDING" | "APPROVED" | "REJECTED";
export type ObjectCleanupStatus = "PENDING" | "RETRY" | "BLOCKED" | "SUCCEEDED";

export type WorkflowType = "concept" | "advanced" | "floorplan" | "self-service";
export type OutputResolution = "0.5K" | "1K" | "2K" | "4K";
export type EffectiveResolution = "0.5K" | OutputResolution;
export type JobPurpose = "preview" | "final";
export type OutputAspectRatio = "1:1" | "4:3" | "3:2" | "16:9" | "9:16";
export type OutputQuality = import("@/lib/domain/image-models").StoredImageQuality;
export type VisualRealism = "conceptual" | "rendered" | "realistic" | "photorealistic";
export type LampState = "on" | "off" | "mixed";
export type SpaceType = "living-room" | "corridor" | "children-room" | "bedroom" | "dining-room" | "kitchen" | "bathroom" | "study" | "unspecified";
export type AdvancedSettingsJson = string;

export type JobStatus =
  | "QUEUED"
  | "PREPROCESSING"
  | "GENERATING"
  | "VALIDATING"
  | "SUCCEEDED"
  | "PARTIAL_SUCCEEDED"
  | "FAILED"
  | "CANCELED";

export type GenerationQueueItemStatus =
  | "QUEUED"
  | "LEASED"
  | "PREPROCESSING"
  | "SUBMITTING"
  | "PERSISTING"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED"
  | "CANCELED";

export type GenerationExecutionKind = "provider" | "acceptance";
export type GenerationAcceptanceScenario =
  | "happy_path"
  | "claim_ack_loss"
  | "output_ack_loss"
  | "spool_recovery"
  | "reconciliation";

export type GenerationAttemptState =
  | "STARTED"
  | "PREPROCESSING"
  | "PROVIDER_DISPATCHING"
  | "PROVIDER_RESPONDED"
  | "STORING"
  | "SUCCEEDED"
  | "FAILED"
  | "AMBIGUOUS";

export type GenerationOutputCommitState =
  | "REJECTED"
  | "PREPARED"
  | "OBJECT_STORED"
  | "COMMITTED"
  | "RECONCILIATION_REQUIRED";

export type GenerationReconciliationState = "OPEN" | "CLOSED";
export type GenerationDeadLetterClassification = "SAFE_BEFORE_PROVIDER_FAILURE";
export type UserStatus = "ACTIVE" | "SUSPENDED";
export type UserRole = "USER" | "ADMIN";
export type CreditLedgerEntryType = "CREDIT" | "RESERVE" | "SETTLE" | "RELEASE";
export type RechargeProvider = "WECHAT_PAY" | "ALIPAY";
export type RechargeOrderStatus = "PENDING" | "PAID" | "CREDITED" | "CANCELED" | "EXPIRED";
export type AdminAuditAction = "USER_UPDATE" | "CREDIT_GRANT" | "CREDIT_COMPENSATION";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  identityNamespace: text("identity_namespace").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  emailRegistrationReceipt: text("email_registration_receipt"),
  wechatRegistrationReceipt: text("wechat_registration_receipt"),
  status: text("status").$type<UserStatus>().notNull().default("ACTIVE"),
  role: text("role").$type<UserRole>().notNull().default("USER"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const userLegalAcceptances = sqliteTable("user_legal_acceptances", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  document: text("document").$type<"terms" | "privacy">().notNull(),
  version: text("version").notNull(),
  acceptedAt: integer("accepted_at").notNull(),
}, table => [primaryKey({ columns: [table.userId, table.document, table.version] }), check("legal_document_valid", sql`${table.document} IN ('terms','privacy')`)]);

export const authIdentities = sqliteTable("auth_identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  providerAppId: text("provider_app_id").notNull(),
  subjectHash: text("subject_hash").notNull(),
  unionHash: text("union_hash"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("uidx_auth_identities_subject").on(table.provider, table.providerAppId, table.subjectHash),
  index("idx_auth_identities_user").on(table.userId),
]);

export const authOauthStates = sqliteTable("auth_oauth_states", {
  inviteCode: text("invite_code"),
  intent: text("intent", { enum: ["login", "bind"] }).notNull().default("login"),
  targetOwnerId: text("target_owner_id").references(() => users.id, { onDelete: "restrict" }),
  initiatingSessionHash: text("initiating_session_hash"),
  stateHash: text("state_hash").primaryKey(),
  browserNonceHash: text("browser_nonce_hash").notNull(),
  returnPath: text("return_path").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("idx_auth_oauth_states_expiry").on(table.expiresAt)]);

export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  expiresAt: integer("expires_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull().default(sql`(unixepoch())`),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  index("idx_auth_sessions_user").on(table.userId, table.revokedAt, table.expiresAt),
  index("idx_auth_sessions_expiry").on(table.expiresAt),
]);

export const authEmailCredentials = sqliteTable("auth_email_credentials", {
  email: text("email").primaryKey(),
  userId: text("user_id").notNull().unique().references(() => users.id, { onDelete: "restrict" }),
  passwordHash: text("password_hash").notNull(),
  verifiedAt: integer("verified_at").notNull(),
  version: integer("version").notNull().default(1),
});

export const authEmailChallenges = sqliteTable("auth_email_challenges", {
  id: text("id").primaryKey(),
  subjectHash: text("subject_hash").notNull(),
  purpose: text("purpose").notNull(),
  answerHash: text("answer_hash").notNull(),
  browserHash: text("browser_hash").notNull(),
  expiresAt: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  attemptBy: text("attempt_by"),
  delivered: integer("delivered").notNull().default(0),
  consumedAt: integer("consumed_at"),
  consumedBy: text("consumed_by"),
}, (table) => [index("idx_auth_email_challenge_expiry").on(table.expiresAt)]);

export const authEmailRateLimits = sqliteTable("auth_email_rate_limits", {
  bucket: text("bucket").primaryKey(),
  count: integer("count").notNull().default(1),
  expiresAt: integer("expires_at").notNull(),
});

export const userGenerationLimits = sqliteTable("user_generation_limits", {
  ownerId: text("owner_id").primaryKey(),
  dailyOutputLimit: integer("daily_output_limit").notNull().default(20),
  maxPendingOutputs: integer("max_pending_outputs").notNull().default(4),
  activeConcurrencyLimit: integer("active_concurrency_limit").notNull().default(1),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const generationQuotaAdmissions = sqliteTable("generation_quota_admissions", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  dayStart: text("day_start").notNull(),
  units: integer("units").notNull(),
  dailyLimitSnapshot: integer("daily_limit_snapshot").notNull(),
  pendingLimitSnapshot: integer("pending_limit_snapshot").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("uidx_generation_quota_owner_idempotency").on(table.ownerId, table.idempotencyKey),
  index("idx_generation_quota_owner_day").on(table.ownerId, table.dayStart, table.createdAt),
]);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    kind: text("kind").$type<AssetKind>().notNull(),
    status: text("status").$type<AssetStatus>().notNull().default("READY"),
    originalFileName: text("original_file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    sanitizationVersion: text("sanitization_version"),
    storageKey: text("storage_key").notNull().unique(),
    parentAssetId: text("parent_asset_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
    retentionExpiresAt: integer("retention_expires_at"),
    deletionRequestedAt: integer("deletion_requested_at"),
    deletionActionId: text("deletion_action_id"),
    purgedAt: integer("purged_at"),
    moderationMode: text("moderation_mode").$type<"disabled" | "tencent">(),
  moderationStatus: text("moderation_status").$type<AssetModerationStatus>().notNull().default("UNREVIEWED"),
    moderatedAt: integer("moderated_at"),
    moderationReason: text("moderation_reason"),
    moderationActionId: text("moderation_action_id"),
  },
  (table) => [
    index("idx_assets_owner_created").on(table.ownerId, table.createdAt),
    index("idx_assets_owner_kind").on(table.ownerId, table.kind),
    index("idx_assets_moderation_created").on(table.moderationStatus, table.createdAt),
    index("idx_assets_retention").on(table.status, table.retentionExpiresAt),
  ],
);

export const assetModerationEvents = sqliteTable("asset_moderation_events", {
  id: text("id").primaryKey(),
  actionId: text("action_id").notNull().unique(),
  assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "restrict" }),
  reviewerId: text("reviewer_id").notNull(),
  decision: text("decision").notNull(),
  reasonHash: text("reason_hash").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("idx_asset_moderation_asset").on(table.assetId, table.createdAt)]);

export const assetDeletionEvents = sqliteTable("asset_deletion_events", {
  id: text("id").primaryKey(),
  actionId: text("action_id").notNull().unique(),
  assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "restrict" }),
  actorId: text("actor_id").notNull(),
  source: text("source").notNull(),
  detailHash: text("detail_hash").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("idx_asset_deletion_asset").on(table.assetId, table.createdAt)]);

export const objectCleanupTasks = sqliteTable("object_cleanup_tasks", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  objectKey: text("object_key").notNull().unique(),
  status: text("status").$type<ObjectCleanupStatus>().notNull().default("PENDING"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull().default(sql`(unixepoch())`),
  lastErrorCode: text("last_error_code"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  completedAt: integer("completed_at"),
}, (table) => [index("idx_object_cleanup_due").on(table.status, table.nextAttemptAt, table.createdAt)]);

export const assetMaintenanceEvents = sqliteTable("asset_maintenance_events", {
  id: text("id").primaryKey(),
  actionId: text("action_id").notNull().unique(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  detailHash: text("detail_hash").notNull(),
  requestId: text("request_id").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("idx_asset_maintenance_created").on(table.createdAt, table.id)]);

export const generationJobs = sqliteTable(
  "generation_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    sourceAssetId: text("source_asset_id").references(() => assets.id, { onDelete: "restrict" }),
    referenceAssetId: text("reference_asset_id").references(() => assets.id, {
      onDelete: "restrict",
    }),
    additionalReferencesJson: text("additional_references_json").notNull().default("[]"),
    maskAssetId: text("mask_asset_id").references(() => assets.id, {
      onDelete: "restrict",
    }),
    depthAssetId: text("depth_asset_id").references(() => assets.id, {
      onDelete: "restrict",
    }),
    normalAssetId: text("normal_asset_id").references(() => assets.id, {
      onDelete: "restrict",
    }),
    workflowType: text("workflow_type")
      .$type<WorkflowType>()
      .notNull()
      .default("concept"),
    purpose: text("purpose").$type<JobPurpose>().notNull().default("final"),
    sourceJobId: text("source_job_id"),
    promotedFromAssetId: text("promoted_from_asset_id"),
    resolution: text("resolution")
      .$type<OutputResolution>()
      .notNull()
      .default("1K"),
    effectiveResolution: text("effective_resolution").$type<EffectiveResolution>().notNull().default("1K"),
    aspectRatio: text("aspect_ratio")
      .$type<OutputAspectRatio>()
      .notNull()
      .default("4:3"),
    quality: text("quality")
      .$type<OutputQuality>()
      .notNull()
      .default("standard"),
    visualRealism: text("visual_realism")
      .$type<VisualRealism>()
      .notNull()
      .default("photorealistic"),
    lampState: text("lamp_state")
      .$type<LampState>()
      .notNull()
      .default("mixed"),
    colorTemperatureKelvin: integer("color_temperature_kelvin")
      .notNull()
      .default(4000),
    spaceType: text("space_type").$type<SpaceType>().notNull().default("unspecified"),
    stylePresetId: text("style_preset_id").notNull(),
    designSchemeId: text("design_scheme_id"),
    lightingPreset: text("lighting_preset").notNull(),
    preservationMode: text("preservation_mode").notNull(),
    providerPreference: text("provider_preference").notNull(),
    editInstruction: text("edit_instruction"),
    customPrompt: text("custom_prompt"),
    outputCount: integer("output_count").notNull(),
    advancedSettingsJson: text("advanced_settings_json").notNull().default('{"version":1,"geometryFidelity":"balanced","cameraPolicy":"locked","furnishingDensity":"balanced","materialExpression":"natural","lightingContrast":"balanced"}'),
    status: text("status").$type<JobStatus>().notNull().default("QUEUED"),
    completedOutputCount: integer("completed_output_count").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    provider: text("provider"),
    model: text("model"),
    providerRequestId: text("provider_request_id"),
    promptTemplateVersion: text("prompt_template_version"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorRetryable: integer("error_retryable", { mode: "boolean" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    uniqueIndex("uidx_generation_jobs_owner_idempotency").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    index("idx_generation_jobs_owner_created").on(
      table.ownerId,
      table.createdAt,
    ),
    index("idx_generation_jobs_owner_workflow_created").on(
      table.ownerId,
      table.workflowType,
      table.createdAt,
      table.id,
    ),
    index("idx_generation_jobs_status_updated").on(
      table.status,
      table.updatedAt,
    ),
    index("idx_generation_jobs_source_job").on(table.sourceJobId),
  ],
);

export const generationJobOutputs = sqliteTable(
  "generation_job_outputs",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("uidx_generation_job_outputs_job_ordinal").on(
      table.jobId,
      table.ordinal,
    ),
    uniqueIndex("uidx_generation_job_outputs_asset").on(table.assetId),
    index("idx_generation_job_outputs_job").on(table.jobId),
  ],
);

/**
 * Durable queue truth lives in D1, one row per billable output operation.
 * The transport used by a future consumer is only a wake-up mechanism.
 */
export const generationJobItems = sqliteTable(
  "generation_job_items",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    providerPreference: text("provider_preference").notNull(),
    providerKey: text("provider_key").notNull(),
    executionKind: text("execution_kind")
      .$type<GenerationExecutionKind>()
      .notNull()
      .default("provider"),
    status: text("status")
      .$type<GenerationQueueItemStatus>()
      .notNull()
      .default("QUEUED"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextAttemptAt: integer("next_attempt_at")
      .notNull()
      .default(sql`(unixepoch())`),
    notifiedAt: integer("notified_at"),
    leaseToken: text("lease_token"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    heartbeatAt: integer("heartbeat_at"),
    currentAttemptId: text("current_attempt_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    lastErrorRetryable: integer("last_error_retryable", { mode: "boolean" }),
    billingReservationId: text("billing_reservation_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("uidx_generation_job_items_job_ordinal").on(
      table.jobId,
      table.ordinal,
    ),
    index("idx_generation_job_items_runnable").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
      table.id,
    ),
    index("idx_generation_job_items_execution_runnable").on(
      table.executionKind,
      table.status,
      table.nextAttemptAt,
      table.createdAt,
      table.id,
    ),
    index("idx_generation_job_items_provider_lease").on(
      table.providerKey,
      table.status,
      table.leaseExpiresAt,
    ),
    index("idx_generation_job_items_owner_lease").on(
      table.ownerId,
      table.status,
      table.leaseExpiresAt,
    ),
  ],
);

export const generationAcceptanceRuns = sqliteTable(
  "generation_acceptance_runs",
  {
    runId: text("run_id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .unique()
      .references(() => generationJobItems.id, { onDelete: "restrict" }),
    scenario: text("scenario")
      .$type<GenerationAcceptanceScenario>()
      .notNull(),
    fixtureSha256: text("fixture_sha256").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("idx_generation_acceptance_runs_updated").on(table.updatedAt)],
);

export const generationAttempts = sqliteTable(
  "generation_attempts",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => generationJobItems.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    leaseToken: text("lease_token").notNull(),
    leaseGeneration: integer("lease_generation").notNull(),
    // These columns were added after the queue table was introduced. They
    // stay nullable at the storage layer so an interrupted/unpublished 0009
    // rollout can still advance safely; every new claim writes both values.
    claimRequestId: text("claim_request_id"),
    claimWorkerId: text("claim_worker_id"),
    state: text("state")
      .$type<GenerationAttemptState>()
      .notNull()
      .default("STARTED"),
    provider: text("provider"),
    model: text("model"),
    providerAccountSlot: text("provider_account_slot"),
    providerRequestId: text("provider_request_id"),
    retryClass: text("retry_class"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at").notNull().default(sql`(unixepoch())`),
    heartbeatAt: integer("heartbeat_at"),
    providerStartedAt: integer("provider_started_at"),
    providerRespondedAt: integer("provider_responded_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("uidx_generation_attempts_item_attempt").on(
      table.itemId,
      table.attemptNo,
    ),
    uniqueIndex("uidx_generation_attempts_lease_token").on(table.leaseToken),
    uniqueIndex("uidx_generation_attempts_claim_request").on(
      table.claimRequestId,
    ),
    index("idx_generation_attempts_item_started").on(
      table.itemId,
      table.startedAt,
    ),
  ],
);

export const promptOptimizationRequests = sqliteTable("prompt_optimization_requests", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(), context: text("context").notNull(),
  model: text("model").notNull(), templateVersion: text("template_version").notNull(), priceVersion: text("price_version").notNull(),
  tokenCap: integer("token_cap").notNull(), cap: integer("cap").notNull(), status: text("status").notNull().default("QUOTED"),
  result: text("result"), inputTokens: integer("input_tokens"), actual: integer("actual"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`), expiresAt: integer("expires_at").notNull(), finishedAt: integer("finished_at"),
}, (table) => [uniqueIndex("uidx_prompt_optimization_owner_idempotency").on(table.ownerId, table.idempotencyKey), index("idx_prompt_optimization_owner_created").on(table.ownerId, table.createdAt)]);

export const creditLedgerEntries = sqliteTable("credit_ledger_entries", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  entryType: text("entry_type").$type<CreditLedgerEntryType>().notNull(),
  amount: integer("amount").notNull(),
  optimizationId: text("optimization_id").references(() => promptOptimizationRequests.id, { onDelete: "restrict" }),
  reservationId: text("reservation_id"),
  jobId: text("job_id").references(() => generationJobs.id, { onDelete: "restrict" }),
  itemId: text("item_id").references(() => generationJobItems.id, { onDelete: "restrict" }),
  attemptId: text("attempt_id").references(() => generationAttempts.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  reasonCode: text("reason_code").notNull(),
  priceVersion: text("price_version"),
  actorId: text("actor_id").notNull(),
  requestId: text("request_id").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("uidx_credit_ledger_owner_idempotency").on(table.ownerId, table.idempotencyKey),
  index("idx_credit_ledger_owner_created").on(table.ownerId, table.createdAt, table.id),
  index("idx_credit_ledger_created").on(table.createdAt, table.id),
]);

export const rechargeOrders = sqliteTable("recharge_orders", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  provider: text("provider").$type<RechargeProvider>().notNull(),
  productCode: text("product_code").notNull(),
  catalogVersion: text("catalog_version").notNull(),
  amountFen: integer("amount_fen").notNull(),
  credits: integer("credits").notNull(),
  status: text("status").$type<RechargeOrderStatus>().notNull().default("PENDING"),
  idempotencyKey: text("idempotency_key").notNull(),
  creditLedgerEntryId: text("credit_ledger_entry_id").references(() => creditLedgerEntries.id, { onDelete: "restrict" }),
  expiresAt: integer("expires_at").notNull(),
  paidAt: integer("paid_at"),
  creditedAt: integer("credited_at"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  check("recharge_orders_catalog_version", sql`${table.catalogVersion} = 'cn-recharge-v1-20260913'`),
  check("recharge_orders_catalog_price", sql`(
    (${table.productCode} = 'CNY10' AND ${table.amountFen} = 1000 AND ${table.credits} = 1000)
    OR (${table.productCode} = 'CNY30' AND ${table.amountFen} = 3000 AND ${table.credits} = 3000)
    OR (${table.productCode} = 'CNY50' AND ${table.amountFen} = 5000 AND ${table.credits} = 5000)
    OR (${table.productCode} = 'CNY100' AND ${table.amountFen} = 10000 AND ${table.credits} = 10000)
  )`),
  uniqueIndex("uidx_recharge_orders_owner_idempotency").on(table.ownerId, table.idempotencyKey),
  uniqueIndex("uidx_recharge_orders_credit_ledger").on(table.creditLedgerEntryId),
  index("idx_recharge_orders_owner_created").on(table.ownerId, table.createdAt, table.id),
  index("idx_recharge_orders_status_updated").on(table.status, table.updatedAt, table.id),
]);

export const rechargePaymentEvents = sqliteTable("recharge_payment_events", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => rechargeOrders.id, { onDelete: "restrict" }),
  provider: text("provider").$type<RechargeProvider>().notNull(),
  providerEventId: text("provider_event_id").notNull(),
  providerTransactionId: text("provider_transaction_id").notNull(),
  amountFen: integer("amount_fen").notNull(),
  payloadHash: text("payload_hash").notNull(),
  paidAt: integer("paid_at").notNull(),
  verifiedAt: integer("verified_at").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [
  uniqueIndex("uidx_recharge_payment_provider_event").on(table.provider, table.providerEventId),
  uniqueIndex("uidx_recharge_payment_provider_transaction").on(table.provider, table.providerTransactionId),
  index("idx_recharge_payment_order").on(table.orderId, table.createdAt),
]);

export const adminAuditEvents = sqliteTable("admin_audit_events", {
  id: text("id").primaryKey(),
  actionId: text("action_id").notNull().unique(),
  actorId: text("actor_id").notNull(),
  action: text("action").$type<AdminAuditAction>().notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  payloadHash: text("payload_hash").notNull(),
  detailJson: text("detail_json").notNull(),
  requestId: text("request_id").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("idx_admin_audit_created").on(table.createdAt, table.id)]);

export const sitePageViews = sqliteTable("site_page_views", {
  id: text("id").primaryKey(),
  visitorHash: text("visitor_hash").notNull(),
  path: text("path").notNull(),
  startedAt: integer("started_at").notNull().default(sql`(unixepoch())`),
  endedAt: integer("ended_at"),
  durationSeconds: integer("duration_seconds"),
}, (table) => [
  index("idx_site_page_views_started").on(table.startedAt, table.id),
  index("idx_site_page_views_visitor_started").on(table.visitorHash, table.startedAt),
]);

/**
 * Short-lived replay protection for the CVM-to-Sites queue control plane.
 * Only a hash of the client nonce is persisted; authentication secrets never
 * enter D1.
 */
export const generationInternalNonces = sqliteTable(
  "generation_internal_nonces",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    keyId: text("key_id").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("idx_generation_internal_nonces_expires").on(table.expiresAt),
  ],
);

/**
 * Queue-only output reservation. The immutable attempt identity and storage
 * key prevent an expired consumer from publishing over a replacement lease.
 */
export const generationOutputCommits = sqliteTable(
  "generation_output_commits",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .unique()
      .references(() => generationJobItems.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id")
      .notNull()
      .unique()
      .references(() => generationAttempts.id, { onDelete: "cascade" }),
    leaseGeneration: integer("lease_generation").notNull(),
    uploadRequestId: text("upload_request_id").notNull().unique(),
    assetId: text("asset_id").notNull().unique(),
    storageKey: text("storage_key").notNull().unique(),
    providerRequestId: text("provider_request_id"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    sanitizationVersion: text("sanitization_version"),
    state: text("state")
      .$type<GenerationOutputCommitState>()
      .notNull()
      .default("PREPARED"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
    objectStoredAt: integer("object_stored_at"),
    committedAt: integer("committed_at"),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index("idx_generation_output_commits_state_updated").on(
      table.state,
      table.updatedAt,
    ),
  ],
);

export const generationReconciliationCases = sqliteTable(
  "generation_reconciliation_cases",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => generationJobItems.id, { onDelete: "restrict" }),
    attemptId: text("attempt_id").notNull().references(() => generationAttempts.id, { onDelete: "restrict" }),
    jobId: text("job_id").notNull().references(() => generationJobs.id, { onDelete: "restrict" }),
    reasonCode: text("reason_code").notNull(),
    provider: text("provider"),
    model: text("model"),
    providerRequestId: text("provider_request_id"),
    state: text("state").$type<GenerationReconciliationState>().notNull().default("OPEN"),
    resolution: text("resolution"),
    version: integer("version").notNull().default(1),
    openedAt: integer("opened_at").notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [
    uniqueIndex("uidx_generation_reconciliation_item_attempt").on(table.itemId, table.attemptId),
    index("idx_generation_reconciliation_state_updated").on(table.state, table.updatedAt, table.id),
  ],
);

export const generationReconciliationEvents = sqliteTable(
  "generation_reconciliation_events",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull().references(() => generationReconciliationCases.id, { onDelete: "restrict" }),
    actionId: text("action_id").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    note: text("note"),
    requestId: text("request_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("uidx_generation_reconciliation_event_action").on(table.caseId, table.actionId),
    index("idx_generation_reconciliation_events_case_created").on(table.caseId, table.createdAt, table.id),
  ],
);

export const generationQueueAdminActions = sqliteTable(
  "generation_queue_admin_actions",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull(),
    itemId: text("item_id").notNull().references(() => generationJobItems.id, { onDelete: "restrict" }),
    attemptId: text("attempt_id").notNull().references(() => generationAttempts.id, { onDelete: "restrict" }),
    jobId: text("job_id").notNull().references(() => generationJobs.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    fromAttemptNo: integer("from_attempt_no").notNull(),
    fromAttemptCount: integer("from_attempt_count").notNull(),
    reasonCode: text("reason_code").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("uidx_generation_queue_admin_action_id").on(table.actionId),
    uniqueIndex("uidx_generation_queue_admin_item_attempt_action").on(table.itemId, table.attemptId, table.action),
    index("idx_generation_queue_admin_item_created").on(table.itemId, table.createdAt, table.id),
  ],
);

export const generationDeadLetterEntries = sqliteTable(
  "generation_dead_letter_entries",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull().references(() => generationJobItems.id, { onDelete: "restrict" }),
    attemptId: text("attempt_id").notNull().references(() => generationAttempts.id, { onDelete: "restrict" }),
    jobId: text("job_id").notNull().references(() => generationJobs.id, { onDelete: "restrict" }),
    classification: text("classification").$type<GenerationDeadLetterClassification>().notNull(),
    reasonCode: text("reason_code").notNull(),
    retryClass: text("retry_class").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    openedAt: integer("opened_at").notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("uidx_generation_dead_letter_item_attempt").on(table.itemId, table.attemptId),
    index("idx_generation_dead_letter_opened").on(table.openedAt, table.id),
  ],
);

export const studioTemplates = sqliteTable("studio_templates", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), workflowType: text("workflow_type").notNull(), name: text("name").notNull(), configJson: text("config_json").notNull(), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`), updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_studio_templates_owner").on(table.ownerId, table.updatedAt)]);

export const templateShares = sqliteTable("template_shares", {
  id: text("id").primaryKey(), templateId: text("template_id").notNull().references(() => studioTemplates.id, { onDelete: "cascade" }), tokenHash: text("token_hash").notNull().unique(), revokedAt: text("revoked_at"), createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("idx_template_shares_template").on(table.templateId)]);

export type GalleryCategory = "interior" | "landscape" | "architecture";
export type GalleryStatus = "PENDING" | "APPROVED" | "REJECTED" | "REVOKED";

export const galleryItems = sqliteTable("gallery_items", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  sourceAssetId: text("source_asset_id").notNull().references(() => assets.id, { onDelete: "restrict" }),
  category: text("category").$type<GalleryCategory>().notNull(), title: text("title").notNull(), note: text("note").notNull().default(""),
  publicPrompt: text("public_prompt"), consentVersion: text("consent_version").notNull(), imageConsentAt: text("image_consent_at").notNull(), promptConsentAt: text("prompt_consent_at"),
  thumbKey: text("thumb_key").notNull(), displayKey: text("display_key").notNull(), thumbMime: text("thumb_mime").notNull().default("image/webp"), displayMime: text("display_mime").notNull().default("image/webp"), thumbBytes: integer("thumb_bytes").notNull(), displayBytes: integer("display_bytes").notNull(), thumbSha256: text("thumb_sha256").notNull(), displaySha256: text("display_sha256").notNull(), width: integer("width").notNull(), height: integer("height").notNull(),
  status: text("status").$type<GalleryStatus>().notNull().default("PENDING"), submittedAt: text("submitted_at").notNull(), reviewedAt: text("reviewed_at"), publishedAt: text("published_at"), rejectedAt: text("rejected_at"), revokedAt: text("revoked_at"), updatedAt: text("updated_at").notNull(), reviewerOwnerId: text("reviewer_owner_id"), reviewNote: text("review_note"), retentionExpiresAt: integer("retention_expires_at"),
}, (table) => [index("idx_gallery_public_feed").on(table.status, table.publishedAt, table.id), index("idx_gallery_public_category_feed").on(table.status, table.category, table.publishedAt, table.id), index("idx_gallery_owner_submissions").on(table.ownerId, table.submittedAt), index("idx_gallery_retention").on(table.status, table.retentionExpiresAt), uniqueIndex("uidx_gallery_active_source").on(table.sourceAssetId).where(sql`${table.status} IN ('PENDING', 'APPROVED')`)]);

export const galleryAuditEvents = sqliteTable("gallery_audit_events", {
  id: text("id").primaryKey(),
  actionId: text("action_id").notNull().unique(),
  galleryId: text("gallery_id").notNull().references(() => galleryItems.id, { onDelete: "restrict" }),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  detailHash: text("detail_hash").notNull(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, (table) => [index("idx_gallery_audit_gallery").on(table.galleryId, table.createdAt)]);

export const referralPromoters = sqliteTable("referral_promoters", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "restrict" }),
  enabled: integer("enabled").notNull().default(1),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
}, table => [check("referral_promoter_enabled", sql`${table.enabled} IN (0,1)`)]);
export const userReferrals = sqliteTable("user_referrals", {
  inviteeId: text("invitee_id").primaryKey().references(() => users.id, { onDelete: "restrict" }),
  promoterId: text("promoter_id").notNull().references(() => referralPromoters.userId, { onDelete: "restrict" }),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
}, table => [index("idx_referral_promoter").on(table.promoterId, table.inviteeId), check("referral_not_self", sql`${table.inviteeId} <> ${table.promoterId}`)]);
// The native-payment tables and cross-table guards are defined in SQL migrations 0028 and 0035.
export const referralOrderTerms = sqliteTable("referral_order_terms", {
  orderId: text("order_id").primaryKey(),
  inviteeId: text("invitee_id").notNull().references(() => userReferrals.inviteeId, { onDelete: "restrict" }),
  promoterId: text("promoter_id").notNull().references(() => referralPromoters.userId, { onDelete: "restrict" }),
  ruleVersion: text("rule_version").notNull(),
  commissionBps: integer("commission_bps").notNull(), bonusBps: integer("bonus_bps").notNull(),
  amountFen: integer("amount_fen").notNull(), bonusCredits: integer("bonus_credits").notNull(), commissionFen: integer("commission_fen").notNull(),
}, table => [check("referral_commission_bps",sql`${table.commissionBps} BETWEEN 0 AND 10000`),check("referral_bonus_bps",sql`${table.bonusBps} BETWEEN 0 AND 10000`),check("referral_amount",sql`${table.amountFen}>0`),check("referral_bonus",sql`${table.bonusCredits}>0`),check("referral_commission",sql`${table.commissionFen}>=0`)]);
export const referralRewards = sqliteTable("referral_rewards", {
  orderId: text("order_id").primaryKey().references(() => referralOrderTerms.orderId, { onDelete: "restrict" }),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});
