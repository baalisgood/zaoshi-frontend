import { runtimeModeration, type ContentModeration } from "./machine-moderation";
import { createHash } from "node:crypto";
import type {
  GenerationOutputCommitState,
  GenerationQueueItemStatus,
} from "@/db/schema";
import {
  isImageModel,
} from "@/lib/domain/image-models";
import type {
  GenerationWorkInput as InternalWorkInput,
  GenerationWorkSpec as InternalWorkSpec,
} from "@/lib/domain/generation-work";
import {
  ACCEPTANCE_FIXTURE_BYTE_SIZE,
  ACCEPTANCE_FIXTURE_MIME_TYPE,
  ACCEPTANCE_FIXTURE_SHA256,
  ACCEPTANCE_MODEL,
  ACCEPTANCE_PROMPT_VERSION,
  isAcceptanceScenario,
} from "@/lib/domain/acceptance-fixture";
import {
  mapPreservation,
  parseAdditionalReferencesJson,
  referenceAssetKindsForWorkflow,
  safeParseAdvancedSettingsJson,
  sourceAssetKindsForWorkflow,
  type PreservationMode,
} from "./job-contract";
import { assertDomesticInputAssetMetadata } from "./runtime-policy";
import { ApiError } from "./api";
import { validateGeneratedImage } from "./files";
import { IMAGE_SANITIZATION_VERSION } from "@/lib/platform/image-sanitizer";
import type { InternalQueueRuntime } from "./internal-queue-runtime";
import {
  D1GenerationQueue,
  JOB_AGGREGATE_ASSIGNMENTS,
  type QueueFence,
  type QueueFenceSnapshot,
} from "./generation-queue";
import {
  createInputTicket,
  createOutputTicket,
  verifyInputTicket,
  verifyOutputTicket,
  type InternalQueueTicketConfig,
  type OutputTicketClaims,
} from "./internal-queue-ticket";
import { assertPrivateTestStoredJob, type PrivateTestConfig } from "./private-test";

import { MAX_INTERNAL_OUTPUT_BYTES } from "./internal-queue-contract";
export { MAX_INTERNAL_OUTPUT_BYTES } from "./internal-queue-contract";
export type OutputPublicationResult = "applied" | "already_applied" | "moderation_pending" | "rejected";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/u;
const SUPPORTED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

export function createInternalQueueExecutionService(
  runtime: InternalQueueRuntime,
  d1: D1Database,
): InternalQueueExecutionService {
  if (!runtime.auth.enabled) {
    throw new ApiError(404, "NOT_FOUND", "没有找到这个接口。");
  }
  if (!runtime.r2) {
    throw new ApiError(
      503,
      "QUEUE_REQUIRES_R2",
      "内部持久任务队列需要 R2。",
    );
  }
  if (!runtime.ticket) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_TICKET_MISCONFIGURED",
      "内部任务票据尚未配置。",
    );
  }
  return new InternalQueueExecutionService(
    d1,
    runtime.r2,
    runtime.ticket,
    undefined,
    runtime.acceptanceEnabled,
    runtime.privateTest ?? null,
  );
}

type AssetRow = {
  id: string;
  owner_id: string;
  kind: string;
  status: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  sanitization_version: string | null;
  moderation_status: string;
  moderation_mode: "disabled" | "tencent" | null;
  storage_key: string;
};

type JobRow = {
  id: string;
  owner_id: string;
  source_asset_id: string | null;
  reference_asset_id: string | null;
  additional_references_json: string;
  mask_asset_id: string | null;
  depth_asset_id: string | null;
  normal_asset_id: string | null;
  workflow_type: "concept" | "advanced" | "floorplan" | "self-service";
  purpose: "preview" | "final";
  source_job_id: string | null;
  promoted_from_asset_id: string | null;
  resolution: "0.5K" | "1K" | "2K" | "4K";
  effective_resolution: "0.5K" | "1K" | "2K" | "4K";
  aspect_ratio: "1:1" | "4:3" | "3:2" | "16:9" | "9:16";
  quality: import("@/lib/domain/image-models").StoredImageQuality;
  visual_realism: "conceptual" | "rendered" | "realistic" | "photorealistic";
  lamp_state: "on" | "off" | "mixed";
  color_temperature_kelvin: number;
  space_type?: string;
  style_preset_id: string;
  design_scheme_id: string | null;
  lighting_preset: string;
  preservation_mode: string;
  provider_preference: string;
  edit_instruction: string | null;
  custom_prompt: string | null;
  output_count: number;
  advanced_settings_json: string;
};

type OutputCommitRow = {
  id: string;
  item_id: string;
  attempt_id: string;
  lease_generation: number;
  upload_request_id: string;
  asset_id: string;
  storage_key: string;
  provider_request_id: string | null;
  prompt_template_version: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  sanitization_version: string | null;
  state: GenerationOutputCommitState;
  execution_kind: "provider" | "acceptance";
};

type AcceptanceRunRow = {
  scenario: string;
  fixture_sha256: string;
};

type RequestedInput = {
  assetId: string;
  role: string;
  kinds: readonly string[];
};

export type { InternalWorkInput, InternalWorkSpec };

export class InternalQueueExecutionService {
  constructor(
    private readonly d1: D1Database,
    private readonly bucket: R2Bucket,
    private readonly ticketConfig: InternalQueueTicketConfig,
    private readonly queue = new D1GenerationQueue(d1),
    private readonly acceptanceEnabled = false,
    private readonly privateTest: PrivateTestConfig | null = null,
    private readonly moderation?: ContentModeration,
  ) {}

  async createWork(fence: QueueFence): Promise<InternalWorkSpec> {
    const snapshot = await this.requireActiveFence(fence, ["PREPROCESSING"]);
    const attemptId = requireAttempt(snapshot);
    const leaseExpiresAt = requireLeaseExpiry(snapshot);
    const job = await this.readJob(snapshot.jobId);
    if (snapshot.executionKind === "acceptance") {
      if (!this.acceptanceEnabled) {
        throw new ApiError(404, "QUEUE_ACCEPTANCE_DISABLED", "没有找到这个接口。");
      }
      return this.createAcceptanceWork(
        fence,
        snapshot,
        job,
        attemptId,
        leaseExpiresAt,
      );
    }
    if (
      job.owner_id !== snapshot.ownerId ||
      job.provider_preference !== snapshot.providerPreference ||
      !isImageModel(job.provider_preference)
    ) {
      throw new ApiError(
        409,
        "QUEUE_WORK_CONFLICT",
        "任务执行配置与队列冻结配置不一致。",
      );
    }
    if (this.privateTest) {
      assertPrivateTestStoredJob(job);
    }
    if (job.mask_asset_id) {
      throw new ApiError(
        409,
        "QUEUE_MASK_UNSUPPORTED",
        "国产模型队列暂不接受透明蒙版硬选区。",
      );
    }

    const requested = requestedInputs(job);
    if (job.workflow_type !== "self-service" && !job.source_asset_id) {
      throw new ApiError(409, "QUEUE_SOURCE_MISSING", "任务缺少原始图片。");
    }
    const assets: AssetRow[] = [];
    for (const expected of requested) {
      const asset = await this.readAsset(expected.assetId);
      if (
        !asset ||
        asset.owner_id !== snapshot.ownerId ||
        asset.status !== "READY" ||
        asset.sanitization_version !== IMAGE_SANITIZATION_VERSION ||
        (snapshot.executionKind === "provider" && asset.moderation_status === "REJECTED") ||
        !expected.kinds.includes(asset.kind)
      ) {
        throw new ApiError(
          409,
          "QUEUE_INPUT_NOT_READY",
          "任务输入图片不存在、未就绪或类型不正确。",
        );
      }
      assets.push(asset);
    }
    assertDomesticInputAssetMetadata(
      job.provider_preference,
      assets.map((asset) => ({
        mimeType: asset.mime_type,
        byteSize: asset.byte_size,
      })),
    );

    const audit = this.moderation ?? await runtimeModeration(this.d1);
    await audit.text(snapshot.ownerId, [job.custom_prompt, job.edit_instruction].filter(Boolean).join("\n"));
    for (const asset of assets) {
      const object = await this.bucket.get(asset.storage_key);
      if (!object) throw new ApiError(410, "QUEUE_INPUT_MISSING", "任务输入文件已经不可用。");
      await audit.asset(snapshot.ownerId, asset.id, new Uint8Array(await object.arrayBuffer()));
    }
    await this.requireActiveFence(fence, ["PREPROCESSING"]);
    const inputs: InternalWorkInput[] = [];
    for (const [index, asset] of assets.entries()) {
      const role = requested[index]!.role;
      inputs.push({
        role,
        index,
        mimeType: asset.mime_type,
        byteSize: asset.byte_size,
        sha256: asset.sha256,
        ticket: await createInputTicket({
          config: this.ticketConfig,
          fence,
          attemptId,
          assetId: asset.id,
          role,
          index,
          mimeType: asset.mime_type,
          byteSize: asset.byte_size,
          sha256: asset.sha256,
          leaseExpiresAt,
        }),
      });
    }

    return {
      version: 1,
      executionKind: "provider",
      itemId: fence.itemId,
      attemptId,
      outputOrdinal: snapshot.ordinal,
      totalOutputs: job.output_count,
      providerPreference: job.provider_preference,
      workflowType: job.workflow_type,
      spaceType: (job.space_type ?? "unspecified") as InternalWorkSpec["spaceType"],
      purpose: job.purpose,
      resolution: job.effective_resolution,
      aspectRatio: job.aspect_ratio,
      quality: job.quality,
      visualRealism: job.visual_realism,
      stylePresetId: job.style_preset_id,
      designSchemeId: job.design_scheme_id,
      lightingPreset: job.lighting_preset as InternalWorkSpec["lightingPreset"],
      lampState: job.lamp_state,
      colorTemperatureKelvin: job.color_temperature_kelvin,
      renovationScope: mapPreservation(
        job.preservation_mode as PreservationMode,
        job.workflow_type,
      ),
      promotedFromPreview: Boolean(
        job.source_job_id && job.promoted_from_asset_id,
      ),
      editInstruction: job.edit_instruction,
      customPrompt: job.custom_prompt,
      advancedSettings:
        job.workflow_type === "advanced"
          ? safeParseAdvancedSettingsJson(job.advanced_settings_json)
          : null,
      outputCount: 1,
      inputs,
    };
  }

  private async createAcceptanceWork(
    fence: QueueFence,
    snapshot: QueueFenceSnapshot,
    job: JobRow,
    attemptId: string,
    leaseExpiresAt: number,
  ): Promise<InternalWorkSpec> {
    const acceptanceRun = await this.readAcceptanceRun(fence.itemId);
    if (
      !acceptanceRun ||
      !isAcceptanceScenario(acceptanceRun.scenario) ||
      acceptanceRun.fixture_sha256 !== ACCEPTANCE_FIXTURE_SHA256 ||
      job.owner_id !== snapshot.ownerId ||
      !job.owner_id.startsWith("queue_acceptance:") ||
      job.provider_preference !== ACCEPTANCE_MODEL ||
      snapshot.providerPreference !== ACCEPTANCE_MODEL ||
      snapshot.providerKey !== "acceptance" ||
      job.workflow_type !== "concept" ||
      job.purpose !== "final" ||
      job.output_count !== 1 ||
      !job.source_asset_id ||
      job.reference_asset_id ||
      job.additional_references_json !== "[]" ||
      job.mask_asset_id ||
      job.depth_asset_id ||
      job.normal_asset_id
    ) {
      throw new ApiError(
        409,
        "QUEUE_ACCEPTANCE_CONFLICT",
        "验收任务配置不完整或已被修改。",
      );
    }
    const asset = await this.readAsset(job.source_asset_id);
    if (
      !asset ||
      asset.owner_id !== snapshot.ownerId ||
      asset.kind !== "source" ||
      asset.status !== "READY" ||
      asset.mime_type !== ACCEPTANCE_FIXTURE_MIME_TYPE ||
      asset.byte_size !== ACCEPTANCE_FIXTURE_BYTE_SIZE ||
      asset.sha256 !== ACCEPTANCE_FIXTURE_SHA256
    ) {
      throw new ApiError(
        409,
        "QUEUE_ACCEPTANCE_INPUT_INVALID",
        "验收任务输入不存在或已被修改。",
      );
    }
    const input: InternalWorkInput = {
      role: "source",
      index: 0,
      mimeType: asset.mime_type,
      byteSize: asset.byte_size,
      sha256: asset.sha256,
      ticket: await createInputTicket({
        config: this.ticketConfig,
        fence,
        attemptId,
        assetId: asset.id,
        role: "source",
        index: 0,
        mimeType: asset.mime_type,
        byteSize: asset.byte_size,
        sha256: asset.sha256,
        leaseExpiresAt,
      }),
    };
    return {
      version: 1,
      executionKind: "acceptance",
      itemId: fence.itemId,
      attemptId,
      outputOrdinal: 0,
      totalOutputs: 1,
      providerPreference: ACCEPTANCE_MODEL,
      workflowType: "concept",
      purpose: "final",
      resolution: "0.5K",
      aspectRatio: "1:1",
      quality: "draft",
      visualRealism: "conceptual",
      stylePresetId: ACCEPTANCE_MODEL,
      lightingPreset: "noon",
      lampState: "off",
      colorTemperatureKelvin: 4000,
      renovationScope: "restyle",
      promotedFromPreview: false,
      editInstruction: null,
      customPrompt: null,
      advancedSettings: null,
      outputCount: 1,
      inputs: [input],
    };
  }

  async readInput(
    fence: QueueFence,
    token: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; byteSize: number; sha256: string }> {
    const claims = await verifyInputTicket(
      token,
      this.ticketConfig,
      fence,
    );
    const snapshot = await this.requireActiveFence(fence, ["PREPROCESSING"]);
    if (requireAttempt(snapshot) !== claims.attemptId) throw staleFence();
    const job = await this.readJob(snapshot.jobId);
    if (!this.workIdentityMatches(snapshot, job)) {
      throw new ApiError(
        409,
        "QUEUE_WORK_CONFLICT",
        "任务执行配置与队列冻结配置不一致。",
      );
    }
    const expected = requestedInputs(job)[claims.index];
    if (
      !expected ||
      expected.assetId !== claims.assetId ||
      expected.role !== claims.role
    ) {
      throw new ApiError(
        409,
        "QUEUE_INPUT_CONFLICT",
        "任务输入图片与当前任务清单不一致。",
      );
    }
    const asset = await this.readAsset(claims.assetId);
    if (
      !asset ||
      asset.owner_id !== snapshot.ownerId ||
      asset.status !== "READY" ||
      (snapshot.executionKind === "provider" &&
        (asset.sanitization_version !== IMAGE_SANITIZATION_VERSION || asset.moderation_status === "REJECTED")) ||
      asset.mime_type !== claims.mimeType ||
      asset.byte_size !== claims.byteSize ||
      asset.sha256 !== claims.sha256 ||
      !expected.kinds.includes(asset.kind)
    ) {
      throw new ApiError(
        409,
        "QUEUE_INPUT_CONFLICT",
        "任务输入图片与票据不一致。",
      );
    }
    const object = await this.bucket.get(asset.storage_key);
    if (!object) {
      throw new ApiError(410, "QUEUE_INPUT_MISSING", "任务输入文件已经不可用。");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (
      bytes.byteLength !== asset.byte_size ||
      sha256(bytes) !== asset.sha256
    ) {
      throw new ApiError(
        502,
        "QUEUE_INPUT_INTEGRITY",
        "任务输入文件完整性校验失败。",
      );
    }
    if (snapshot.executionKind === "provider") {
      const audit = this.moderation ?? await runtimeModeration(this.d1);
      await audit.asset(snapshot.ownerId, asset.id, bytes);
      await this.requireActiveFence(fence, ["PREPROCESSING"]);
    }
    return {
      bytes,
      mimeType: asset.mime_type,
      byteSize: asset.byte_size,
      sha256: asset.sha256,
    };
  }

  private workIdentityMatches(
    snapshot: QueueFenceSnapshot,
    job: JobRow,
  ): boolean {
    if (
      job.owner_id !== snapshot.ownerId ||
      job.provider_preference !== snapshot.providerPreference
    ) {
      return false;
    }
    if (snapshot.executionKind === "provider") {
      return isImageModel(job.provider_preference);
    }
    return (
      this.acceptanceEnabled &&
      snapshot.executionKind === "acceptance" &&
      snapshot.providerKey === "acceptance" &&
      job.owner_id.startsWith("queue_acceptance:") &&
      job.provider_preference === ACCEPTANCE_MODEL
    );
  }

  async prepareOutput(input: {
    fence: QueueFence;
    uploadRequestId: string;
    providerRequestId: string | null;
    promptTemplateVersion: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    sanitizationVersion: string | null;
  }): Promise<
    | { result: "prepared" | "already_prepared"; commitId: string; ticket: string }
    | { result: "already_committed" | "rejected"; commitId: string; ticket: null }
  > {
    validateOutputDeclaration(input);
    const committedReplay = await this.readCommitByUploadRequest(
      input.uploadRequestId,
    );
    if (committedReplay?.state === "COMMITTED" || committedReplay?.state === "REJECTED") {
      this.assertAcceptanceCommitEnabled(committedReplay);
      assertSameCommit(
        committedReplay,
        input,
        committedReplay.attempt_id,
      );
      return {
        result: committedReplay.state === "REJECTED" ? "rejected" : "already_committed",
        commitId: committedReplay.id,
        ticket: null,
      };
    }
    const snapshot = await this.requireActiveFence(input.fence, ["PERSISTING"]);
    if (snapshot.executionKind === "acceptance") {
      this.assertAcceptanceOutputDeclaration(snapshot, input);
    } else if (input.sanitizationVersion !== IMAGE_SANITIZATION_VERSION) {
      throw new ApiError(
        409,
        "OUTPUT_SANITIZATION_UNPROVEN",
        "供应商输出缺少图片安全处理证明。",
      );
    }
    const attemptId = requireAttempt(snapshot);
    if (snapshot.providerRequestId !== input.providerRequestId) {
      throw new ApiError(
        409,
        "PROVIDER_RESPONSE_CONFLICT",
        "供应商响应标识与当前尝试不一致。",
      );
    }
    const existing =
      committedReplay ??
      (await this.readCommitByItem(input.fence.itemId));
    if (existing) {
      assertSameCommit(existing, input, attemptId);
      if (existing.state === "COMMITTED") {
        return { result: "already_committed", commitId: existing.id, ticket: null };
      }
      return {
        result: "already_prepared",
        commitId: existing.id,
        ticket: await this.outputTicket(existing, input.fence, snapshot),
      };
    }

    const commitId = `ocommit_${crypto.randomUUID()}`;
    const assetId = `asset_queue_${safeId(input.fence.itemId)}`;
    const extension = extensionForMime(input.mimeType);
    const storageKey = `generated/queue/${safeId(snapshot.jobId)}/${snapshot.ordinal}/${safeId(attemptId)}/${safeId(commitId)}.${extension}`;
    const nowIso = new Date().toISOString();
    const outputMode = snapshot.executionKind === "provider" ? (this.moderation ?? await runtimeModeration(this.d1)).mode : null;
    await this.d1.batch([
      this.d1
        .prepare(
          `INSERT OR IGNORE INTO assets
            (id, owner_id, kind, status, original_file_name, mime_type,
             byte_size, sha256, sanitization_version, storage_key, parent_asset_id, created_at,
             retention_expires_at, moderation_status, moderation_mode)
           SELECT ?, item.owner_id, 'output', 'PENDING', ?, ?, ?, ?, ?, ?,
                  job.source_asset_id, ?, unixepoch() + 7776000, 'UNREVIEWED', ?
           FROM generation_job_items AS item
           JOIN generation_attempts AS attempt
             ON attempt.id = item.current_attempt_id
           JOIN generation_jobs AS job ON job.id = item.job_id
           WHERE item.id = ? AND item.current_attempt_id = ?
             AND item.lease_token = ? AND item.lease_generation = ?
             AND attempt.lease_token = ? AND attempt.lease_generation = ?
             AND item.status = 'PERSISTING'
             AND item.lease_expires_at > unixepoch()`,
        )
        .bind(
          assetId,
          `generated-${snapshot.ordinal + 1}.${extension}`,
          input.mimeType,
          input.byteSize,
          input.sha256,
          input.sanitizationVersion,
          storageKey,
          nowIso,
          outputMode,
          input.fence.itemId,
          attemptId,
          input.fence.leaseToken,
          input.fence.leaseGeneration,
          input.fence.leaseToken,
          input.fence.leaseGeneration,
        ),
      this.d1
        .prepare(
          `INSERT OR IGNORE INTO generation_output_commits
            (id, item_id, attempt_id, lease_generation, upload_request_id,
             asset_id, storage_key, provider_request_id,
             prompt_template_version, mime_type, byte_size, sha256,
             sanitization_version)
           SELECT ?, item.id, attempt.id, item.lease_generation, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM generation_job_items AS item
           JOIN generation_attempts AS attempt
             ON attempt.id = item.current_attempt_id
           WHERE item.id = ? AND item.current_attempt_id = ?
             AND item.lease_token = ? AND item.lease_generation = ?
             AND attempt.lease_token = ? AND attempt.lease_generation = ?
             AND item.status = 'PERSISTING'
             AND item.lease_expires_at > unixepoch()
             AND EXISTS (
               SELECT 1 FROM assets
               WHERE assets.id = ? AND assets.storage_key = ?
                 AND assets.owner_id = item.owner_id
                 AND assets.kind = 'output' AND assets.status = 'PENDING'
                 AND assets.mime_type = ? AND assets.byte_size = ?
                 AND assets.sha256 = ?
                 AND assets.sanitization_version IS ?
             )`,
        )
        .bind(
          commitId,
          input.uploadRequestId,
          assetId,
          storageKey,
          input.providerRequestId,
          input.promptTemplateVersion,
          input.mimeType,
          input.byteSize,
          input.sha256,
          input.sanitizationVersion,
          input.fence.itemId,
          attemptId,
          input.fence.leaseToken,
          input.fence.leaseGeneration,
          input.fence.leaseToken,
          input.fence.leaseGeneration,
          assetId,
          storageKey,
          input.mimeType,
          input.byteSize,
          input.sha256,
          input.sanitizationVersion,
        ),
    ]);
    const created =
      (await this.readCommitByUploadRequest(input.uploadRequestId)) ??
      (await this.readCommitByItem(input.fence.itemId));
    if (!created) throw staleFence();
    assertSameCommit(created, input, attemptId);
    return {
      result: created.id === commitId ? "prepared" : "already_prepared",
      commitId: created.id,
      ticket: await this.outputTicket(created, input.fence, snapshot),
    };
  }

  private assertAcceptanceOutputDeclaration(
    snapshot: QueueFenceSnapshot,
    input: {
      providerRequestId: string | null;
      promptTemplateVersion: string;
      mimeType: string;
      byteSize: number;
      sha256: string;
      sanitizationVersion: string | null;
    },
  ): void {
    if (
      !this.acceptanceEnabled ||
      snapshot.providerKey !== "acceptance" ||
      snapshot.providerPreference !== ACCEPTANCE_MODEL ||
      input.providerRequestId !== null ||
      input.promptTemplateVersion !== ACCEPTANCE_PROMPT_VERSION ||
      input.mimeType !== ACCEPTANCE_FIXTURE_MIME_TYPE ||
      input.byteSize !== ACCEPTANCE_FIXTURE_BYTE_SIZE ||
      input.sha256 !== ACCEPTANCE_FIXTURE_SHA256
      || input.sanitizationVersion !== null
    ) {
      throw new ApiError(
        409,
        "QUEUE_ACCEPTANCE_OUTPUT_INVALID",
        "验收任务输出声明与固定测试夹具不一致。",
      );
    }
  }

  async uploadOutput(
    fence: QueueFence,
    token: string,
    bytes: Uint8Array,
    declaredMimeType: string,
  ): Promise<{ result: OutputPublicationResult; assetId: string }> {
    const claims = await verifyOutputTicket(
      token,
      this.ticketConfig,
      fence,
    );
    const commit = await this.readCommit(claims.commitId);
    if (!commit || !commitMatchesTicket(commit, claims)) {
      throw new ApiError(
        409,
        "OUTPUT_COMMIT_CONFLICT",
        "输出提交与任务票据不一致。",
      );
    }
    this.assertAcceptanceCommitEnabled(commit);
    if (
      commit.execution_kind === "provider" &&
      commit.sanitization_version !== IMAGE_SANITIZATION_VERSION
    ) {
      await this.markReconciliation(commit.id, fence);
      throw new ApiError(
        409,
        "OUTPUT_SANITIZATION_UNPROVEN",
        "供应商输出缺少图片安全处理证明。",
      );
    }
    if (declaredMimeType !== commit.mime_type) {
      throw new ApiError(
        409,
        "OUTPUT_CONTENT_CONFLICT",
        "输出文件类型与已登记格式不一致。",
      );
    }
    if (commit.state === "REJECTED") return { result: "rejected", assetId: commit.asset_id };
    if (commit.state === "COMMITTED") {
      return { result: "already_applied", assetId: commit.asset_id };
    }
    const snapshot = await this.requireActiveFence(fence, ["PERSISTING"]);
    if (requireAttempt(snapshot) !== commit.attempt_id) throw staleFence();
    if (bytes.byteLength !== commit.byte_size || sha256(bytes) !== commit.sha256) {
      throw new ApiError(
        409,
        "OUTPUT_CONTENT_CONFLICT",
        "输出文件与已登记摘要不一致。",
      );
    }
    const image = validateGeneratedImage(bytes, commit.mime_type);
    if (image.bytes.byteLength > MAX_INTERNAL_OUTPUT_BYTES) {
      throw new ApiError(413, "OUTPUT_TOO_LARGE", "单张队列输出不能超过 8MB。");
    }

    let object = await this.bucket.get(commit.storage_key);
    if (!object) {
      await this.bucket.put(commit.storage_key, bytes, {
        httpMetadata: { contentType: commit.mime_type },
        customMetadata: {
          commitId: commit.id,
          assetId: commit.asset_id,
          sha256: commit.sha256,
          kind: "output",
          ...(commit.sanitization_version
            ? { sanitizationVersion: commit.sanitization_version }
            : {}),
        },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      object = await this.bucket.get(commit.storage_key);
    }
    if (!object || !(await r2MatchesCommit(object, commit))) {
      await this.markReconciliation(commit.id, fence);
      throw new ApiError(
        409,
        "OUTPUT_STORAGE_CONFLICT",
        "输出对象存储校验失败，任务已转入人工核对。",
      );
    }
    await this.d1
      .prepare(
        `UPDATE generation_output_commits
         SET state = 'OBJECT_STORED', object_stored_at = COALESCE(object_stored_at, unixepoch()),
             updated_at = unixepoch()
         WHERE id = ? AND state IN ('PREPARED','OBJECT_STORED')
           AND EXISTS (
             SELECT 1 FROM generation_job_items AS item
             JOIN generation_attempts AS attempt
               ON attempt.id = item.current_attempt_id
             WHERE item.id = generation_output_commits.item_id
               AND item.current_attempt_id = generation_output_commits.attempt_id
               AND item.lease_token = ? AND item.lease_generation = ?
               AND attempt.lease_token = ?
               AND attempt.lease_generation = generation_output_commits.lease_generation
               AND item.status = 'PERSISTING'
           )`,
      )
      .bind(
        commit.id,
        fence.leaseToken,
        fence.leaseGeneration,
        fence.leaseToken,
      )
      .run();
    return this.finalizeCommit(commit.id, false);
  }

  async recoverStoredOutputs(
    limit: number,
    executionKind: "provider" | "acceptance" = "provider",
    targetAcceptanceItemId?: string,
  ): Promise<{
    recovered: number;
    reconciliationRequired: number;
  }> {
    if (
      (executionKind === "acceptance") !==
      (targetAcceptanceItemId !== undefined)
    ) {
      throw new ApiError(
        400,
        "QUEUE_SWEEP_SCOPE_INVALID",
        "任务恢复范围不正确。",
      );
    }
    if (executionKind === "acceptance" && !this.acceptanceEnabled) {
      throw new ApiError(404, "QUEUE_ACCEPTANCE_DISABLED", "没有找到这个接口。");
    }
    const rows = await this.d1
      .prepare(
        `SELECT oc.id, oc.item_id, oc.attempt_id,
                oc.lease_generation, oc.upload_request_id,
                oc.asset_id, oc.storage_key, oc.provider_request_id,
                oc.prompt_template_version, oc.mime_type,
                oc.byte_size, oc.sha256, oc.sanitization_version,
                oc.state, item.execution_kind
         FROM generation_output_commits AS oc
         JOIN generation_job_items AS item ON item.id = oc.item_id
         WHERE oc.state IN ('PREPARED','OBJECT_STORED')
           AND item.status = 'PERSISTING'
           AND item.execution_kind = ?
           AND (? IS NULL OR oc.item_id = ?)
         ORDER BY oc.updated_at, oc.id
         LIMIT ?`,
      )
      .bind(
        executionKind,
        targetAcceptanceItemId ?? null,
        targetAcceptanceItemId ?? null,
        limit,
      )
      .all<OutputCommitRow>();
    let recovered = 0;
    let reconciliationRequired = 0;
    for (const commit of rows.results ?? []) {
      if (
        commit.execution_kind === "provider" &&
        commit.sanitization_version !== IMAGE_SANITIZATION_VERSION
      ) {
        await this.markReconciliationByCommit(commit.id);
        reconciliationRequired += 1;
        continue;
      }
      const object = await this.bucket.get(commit.storage_key);
      if (object && (await r2MatchesCommit(object, commit))) {
        await this.d1
          .prepare(
            `UPDATE generation_output_commits
             SET state = 'OBJECT_STORED', object_stored_at = COALESCE(object_stored_at, unixepoch()),
                 updated_at = unixepoch()
             WHERE id = ? AND state IN ('PREPARED','OBJECT_STORED')`,
          )
          .bind(commit.id)
          .run();
        const result = await this.finalizeCommit(commit.id, true);
        if (result.result === "applied" || result.result === "already_applied") {
          recovered += 1;
        }
        continue;
      }
      const expired = await this.d1
        .prepare(
          `SELECT 1 AS expired FROM generation_job_items
           WHERE id = ? AND status = 'PERSISTING'
             AND lease_expires_at <= unixepoch()`,
        )
        .bind(commit.item_id)
        .first<{ expired: number }>();
      if (object || expired) {
        await this.markReconciliationByCommit(commit.id);
        reconciliationRequired += 1;
      }
    }
    return { recovered, reconciliationRequired };
  }

  private async finalizeCommit(
    commitId: string,
    allowExpired: boolean,
  ): Promise<{ result: OutputPublicationResult; assetId: string }> {
    const commit = await this.readCommit(commitId);
    if (!commit) {
      throw new ApiError(404, "OUTPUT_COMMIT_NOT_FOUND", "输出提交不存在。");
    }
    if (commit.state === "REJECTED") return { result: "rejected", assetId: commit.asset_id };
    if (commit.state === "COMMITTED") {
      return { result: "already_applied", assetId: commit.asset_id };
    }
    let policyVersion = "";
    if (commit.execution_kind === "provider") {
      const asset = await this.readAsset(commit.asset_id);
      const object = await this.bucket.get(commit.storage_key);
      if (!asset || !object) return {result:"moderation_pending",assetId:commit.asset_id};
      try {
        const audit = this.moderation ?? await runtimeModeration(this.d1);
        policyVersion = audit.policyVersion ?? "";
        if (audit.mode === "disabled" && asset.moderation_mode !== "disabled") return {result:"moderation_pending",assetId:commit.asset_id};
        await audit.asset(asset.owner_id, asset.id, new Uint8Array(await object.arrayBuffer()));
      } catch (error) {
        if (error instanceof ApiError && ["CONTENT_REVIEW_REQUIRED","CONTENT_BLOCKED"].includes(error.code)) {
          if (!policyVersion) throw error;
          return this.rejectModeratedCommit(commit,allowExpired,policyVersion);
        }
        if (error instanceof ApiError && error.code === "MODERATION_UNAVAILABLE") return {result:"moderation_pending",assetId:commit.asset_id};
        throw error;
      }
    }
    const leaseClause = allowExpired ? "" : "AND item.lease_expires_at > unixepoch()";
    const relation = this.d1
      .prepare(
        `INSERT OR IGNORE INTO generation_job_outputs (job_id, asset_id, ordinal)
         SELECT item.job_id, oc.asset_id, item.ordinal
         FROM generation_output_commits AS oc
         JOIN generation_job_items AS item ON item.id = oc.item_id
         JOIN generation_attempts AS attempt ON attempt.id = oc.attempt_id
         JOIN assets AS asset ON asset.id = oc.asset_id
         WHERE oc.id = ? AND oc.state = 'OBJECT_STORED'
           AND item.id = oc.item_id
           AND item.current_attempt_id = oc.attempt_id
           AND item.lease_generation = oc.lease_generation
           AND item.lease_token = attempt.lease_token
           AND attempt.lease_generation = oc.lease_generation
           AND item.status = 'PERSISTING'
           AND asset.owner_id = item.owner_id AND asset.kind = 'output'
           AND asset.status IN ('PENDING','READY')
           AND asset.storage_key = oc.storage_key
           AND asset.sha256 = oc.sha256
           AND asset.byte_size = oc.byte_size
           AND asset.sanitization_version IS oc.sanitization_version
           AND asset.moderation_status <> 'REJECTED'
           AND ((item.execution_kind = 'provider' AND oc.sanitization_version = ? AND EXISTS(SELECT 1 FROM users u WHERE u.id=asset.owner_id AND u.status='ACTIVE') AND (?<>'' OR NOT EXISTS(SELECT 1 FROM asset_moderation_evidence e JOIN assets previous ON previous.id=e.asset_id WHERE previous.owner_id=asset.owner_id AND e.content_sha256=asset.sha256 AND e.decision IN ('Review','Block'))) AND ((?='' AND asset.moderation_mode='disabled') OR EXISTS(SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=asset.id AND e.content_sha256=asset.sha256 AND e.policy_version=? AND e.decision='Pass')))
             OR (item.execution_kind = 'acceptance' AND oc.sanitization_version IS NULL))
           ${leaseClause}`,
      )
      .bind(commitId, IMAGE_SANITIZATION_VERSION, policyVersion, policyVersion, policyVersion);
    await this.d1.batch([
      relation,
      this.d1
        .prepare(
          `UPDATE assets SET status = 'READY', deleted_at = NULL,
             moderation_status = CASE WHEN EXISTS (SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=assets.id AND e.content_sha256=assets.sha256 AND e.policy_version=? AND e.decision='Pass') THEN 'APPROVED' ELSE moderation_status END,
             moderated_at = CASE WHEN EXISTS (SELECT 1 FROM asset_moderation_evidence e WHERE e.asset_id=assets.id AND e.content_sha256=assets.sha256 AND e.policy_version=? AND e.decision='Pass') THEN unixepoch() ELSE moderated_at END
           WHERE id = ? AND status IN ('PENDING','READY') AND moderation_status <> 'REJECTED'
             AND EXISTS (
               SELECT 1 FROM generation_job_outputs
               WHERE asset_id = ?
             )`,
        )
        .bind(policyVersion, policyVersion, commit.asset_id, commit.asset_id),
      this.d1
        .prepare(
          `UPDATE generation_attempts
           SET state = 'SUCCEEDED', finished_at = unixepoch(),
               heartbeat_at = unixepoch()
           WHERE id = ? AND lease_generation = ?
             AND state IN ('PROVIDER_RESPONDED','STORING')
             AND EXISTS (
               SELECT 1 FROM generation_job_outputs AS output
               JOIN generation_output_commits AS oc
                 ON oc.asset_id = output.asset_id
               WHERE oc.id = ? AND oc.attempt_id = generation_attempts.id
             )`,
        )
        .bind(commit.attempt_id, commit.lease_generation, commit.id),
      this.d1
        .prepare(
          `UPDATE generation_job_items
           SET status = 'SUCCEEDED', lease_token = NULL, lease_owner = NULL,
               lease_expires_at = NULL, heartbeat_at = unixepoch(),
               finished_at = unixepoch(), updated_at = unixepoch()
           WHERE id = ? AND current_attempt_id = ?
             AND lease_generation = ? AND status = 'PERSISTING'
             AND EXISTS (
               SELECT 1 FROM generation_attempts
               WHERE id = ? AND state = 'SUCCEEDED'
             )`,
        )
        .bind(
          commit.item_id,
          commit.attempt_id,
          commit.lease_generation,
          commit.attempt_id,
        ),
      this.d1
        .prepare(
          `UPDATE generation_output_commits
           SET state = 'COMMITTED', committed_at = unixepoch(), updated_at = unixepoch()
           WHERE id = ? AND state = 'OBJECT_STORED'
             AND EXISTS (
               SELECT 1 FROM generation_job_items
               WHERE id = generation_output_commits.item_id
                 AND current_attempt_id = generation_output_commits.attempt_id
                 AND status = 'SUCCEEDED'
             )`,
        )
        .bind(commit.id),
      this.d1
        .prepare(
          `UPDATE generation_jobs ${JOB_AGGREGATE_ASSIGNMENTS}
           WHERE id = (
             SELECT job_id FROM generation_job_items WHERE id = ?
           )`,
        )
        .bind(commit.item_id),
    ]);
    const resolved = await this.readCommit(commit.id);
    if (resolved?.state === "COMMITTED") {
      return { result: "applied", assetId: resolved.asset_id };
    }
    throw staleFence();
  }

  private async rejectModeratedCommit(commit: OutputCommitRow,allowExpired:boolean,policyVersion:string):Promise<{result:OutputPublicationResult;assetId:string}> {
    await this.d1.batch([
      this.d1.prepare(`INSERT INTO generation_moderation_rejections(commit_id,item_id,attempt_id,asset_id,owner_id,job_id,lease_generation,lease_token,reservation_id,amount,price_version,content_sha256,sanitization_version,policy_version,request_id,decision,recovery)
      SELECT oc.id,item.id,attempt.id,asset.id,item.owner_id,item.job_id,item.lease_generation,item.lease_token,reserved.reservation_id,reserved.amount,reserved.price_version,asset.sha256,asset.sanitization_version,e.policy_version,e.request_id,e.decision,?
      FROM generation_output_commits oc JOIN generation_job_items item ON item.id=oc.item_id JOIN generation_attempts attempt ON attempt.id=oc.attempt_id JOIN assets asset ON asset.id=oc.asset_id JOIN asset_moderation_evidence e ON e.asset_id=asset.id JOIN credit_ledger_entries reserved ON reserved.reservation_id=item.billing_reservation_id AND reserved.entry_type='RESERVE'
      WHERE oc.id=? AND oc.state='OBJECT_STORED' AND item.status='PERSISTING' AND item.current_attempt_id=oc.attempt_id AND item.lease_generation=oc.lease_generation AND e.content_sha256=asset.sha256 AND e.policy_version=? AND e.decision IN ('Review','Block') AND (?=1 OR item.lease_expires_at>unixepoch())`).bind(allowExpired?1:0,commit.id,policyVersion,allowExpired?1:0),
      this.d1.prepare(`UPDATE generation_jobs ${JOB_AGGREGATE_ASSIGNMENTS} WHERE id=(SELECT job_id FROM generation_job_items WHERE id=?)`).bind(commit.item_id),
    ]);
    const resolved=await this.readCommit(commit.id);
    if(resolved?.state!=="REJECTED")throw staleFence();
    return {result:"rejected",assetId:commit.asset_id};
  }

  private async markReconciliation(commitId: string, fence: QueueFence): Promise<void> {
    const snapshot = await this.queue.inspectFence(fence);
    if (
      snapshot?.currentAttemptId &&
      snapshot.itemLeaseToken === fence.leaseToken &&
      snapshot.leaseGeneration === fence.leaseGeneration &&
      snapshot.attemptLeaseToken === fence.leaseToken &&
      snapshot.attemptLeaseGeneration === fence.leaseGeneration
    ) {
      await this.markReconciliationByCommit(commitId);
    }
  }

  private async markReconciliationByCommit(commitId: string): Promise<void> {
    await this.d1.batch([
      this.d1
        .prepare(
          `UPDATE generation_output_commits
           SET state = 'RECONCILIATION_REQUIRED', updated_at = unixepoch()
           WHERE id = ? AND state <> 'COMMITTED'
             AND EXISTS (
               SELECT 1 FROM generation_job_items AS item
               WHERE item.id = generation_output_commits.item_id
                 AND item.current_attempt_id = generation_output_commits.attempt_id
                 AND item.lease_generation = generation_output_commits.lease_generation
                 AND item.status = 'PERSISTING'
             )`,
        )
        .bind(commitId),
      this.d1
        .prepare(
          `UPDATE generation_attempts
           SET state = 'AMBIGUOUS', error_code = 'OUTPUT_COMMIT_UNCERTAIN',
               error_message = 'Queue output requires reconciliation',
               finished_at = unixepoch()
           WHERE id = (
             SELECT attempt_id FROM generation_output_commits WHERE id = ?
           ) AND state <> 'SUCCEEDED'
             AND EXISTS (
               SELECT 1
               FROM generation_output_commits AS oc
               JOIN generation_job_items AS item ON item.id = oc.item_id
               WHERE oc.id = ?
                 AND oc.attempt_id = generation_attempts.id
                 AND item.current_attempt_id = oc.attempt_id
                 AND item.lease_generation = oc.lease_generation
                 AND item.status = 'PERSISTING'
             )`,
        )
        .bind(commitId, commitId),
      this.d1
        .prepare(
          `UPDATE generation_job_items
           SET status = 'RECONCILIATION_REQUIRED', lease_token = NULL,
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = 'OUTPUT_COMMIT_UNCERTAIN',
               last_error_message = 'Queue output requires reconciliation',
               last_error_retryable = 0, finished_at = unixepoch(),
               updated_at = unixepoch()
           WHERE id = (
             SELECT item_id FROM generation_output_commits WHERE id = ?
           ) AND current_attempt_id = (
             SELECT attempt_id FROM generation_output_commits WHERE id = ?
           ) AND lease_generation = (
             SELECT lease_generation FROM generation_output_commits WHERE id = ?
           ) AND status = 'PERSISTING'`,
        )
        .bind(commitId, commitId, commitId),
      this.d1
        .prepare(
          `UPDATE generation_jobs ${JOB_AGGREGATE_ASSIGNMENTS}
           WHERE id = (
             SELECT item.job_id
             FROM generation_output_commits AS oc
             JOIN generation_job_items AS item ON item.id = oc.item_id
             WHERE oc.id = ?
           )`,
        )
        .bind(commitId),
    ]);
  }

  private async outputTicket(
    commit: OutputCommitRow,
    fence: QueueFence,
    snapshot: QueueFenceSnapshot,
  ): Promise<string> {
    return createOutputTicket({
      config: this.ticketConfig,
      fence,
      attemptId: commit.attempt_id,
      commitId: commit.id,
      mimeType: commit.mime_type,
      byteSize: commit.byte_size,
      sha256: commit.sha256,
      leaseExpiresAt: requireLeaseExpiry(snapshot),
    });
  }

  private async requireActiveFence(
    fence: QueueFence,
    statuses: readonly GenerationQueueItemStatus[],
  ): Promise<QueueFenceSnapshot> {
    const snapshot = await this.queue.inspectFence(fence);
    if (
      !snapshot ||
      snapshot.itemLeaseToken !== fence.leaseToken ||
      snapshot.leaseGeneration !== fence.leaseGeneration ||
      snapshot.attemptLeaseToken !== fence.leaseToken ||
      snapshot.attemptLeaseGeneration !== fence.leaseGeneration ||
      !snapshot.leaseValid
    ) {
      throw staleFence();
    }
    if (!statuses.includes(snapshot.itemStatus)) {
      throw new ApiError(
        409,
        "QUEUE_STATE_CONFLICT",
        "任务当前状态不允许执行这个操作。",
      );
    }
    return snapshot;
  }

  private async readJob(id: string): Promise<JobRow> {
    const row = await this.d1
      .prepare(
        `SELECT id, owner_id, source_asset_id, reference_asset_id,
                additional_references_json, mask_asset_id, depth_asset_id,
                normal_asset_id, workflow_type, purpose, source_job_id,
                promoted_from_asset_id, resolution, effective_resolution,
                aspect_ratio, quality, visual_realism, lamp_state,
                color_temperature_kelvin, space_type, style_preset_id, design_scheme_id, lighting_preset,
                preservation_mode, provider_preference, edit_instruction,
                custom_prompt, output_count, advanced_settings_json
         FROM generation_jobs WHERE id = ?`,
      )
      .bind(id)
      .first<JobRow>();
    if (!row) throw new ApiError(404, "JOB_NOT_FOUND", "生成任务不存在。");
    return row;
  }

  private readAsset(id: string): Promise<AssetRow | null> {
    return this.d1
      .prepare(
        `SELECT id, owner_id, kind, status, mime_type, byte_size, sha256,
                sanitization_version, moderation_status, moderation_mode, storage_key
         FROM assets WHERE id = ?`,
      )
      .bind(id)
      .first<AssetRow>();
  }

  private readAcceptanceRun(itemId: string): Promise<AcceptanceRunRow | null> {
    return this.d1
      .prepare(
        `SELECT scenario, fixture_sha256
         FROM generation_acceptance_runs
         WHERE item_id = ?`,
      )
      .bind(itemId)
      .first<AcceptanceRunRow>();
  }

  private readCommit(id: string): Promise<OutputCommitRow | null> {
    return this.d1
      .prepare(
        `SELECT oc.id, oc.item_id, oc.attempt_id, oc.lease_generation,
                oc.upload_request_id, oc.asset_id, oc.storage_key,
                oc.provider_request_id, oc.prompt_template_version,
                oc.mime_type, oc.byte_size, oc.sha256,
                oc.sanitization_version, oc.state,
                item.execution_kind
         FROM generation_output_commits AS oc
         JOIN generation_job_items AS item ON item.id = oc.item_id
         WHERE oc.id = ?`,
      )
      .bind(id)
      .first<OutputCommitRow>();
  }

  private readCommitByUploadRequest(id: string): Promise<OutputCommitRow | null> {
    return this.d1
      .prepare(
        `SELECT oc.id, oc.item_id, oc.attempt_id, oc.lease_generation,
                oc.upload_request_id, oc.asset_id, oc.storage_key,
                oc.provider_request_id, oc.prompt_template_version,
                oc.mime_type, oc.byte_size, oc.sha256,
                oc.sanitization_version, oc.state,
                item.execution_kind
         FROM generation_output_commits AS oc
         JOIN generation_job_items AS item ON item.id = oc.item_id
         WHERE oc.upload_request_id = ?`,
      )
      .bind(id)
      .first<OutputCommitRow>();
  }

  private readCommitByItem(id: string): Promise<OutputCommitRow | null> {
    return this.d1
      .prepare(
        `SELECT oc.id, oc.item_id, oc.attempt_id, oc.lease_generation,
                oc.upload_request_id, oc.asset_id, oc.storage_key,
                oc.provider_request_id, oc.prompt_template_version,
                oc.mime_type, oc.byte_size, oc.sha256,
                oc.sanitization_version, oc.state,
                item.execution_kind
         FROM generation_output_commits AS oc
         JOIN generation_job_items AS item ON item.id = oc.item_id
         WHERE oc.item_id = ?`,
      )
      .bind(id)
      .first<OutputCommitRow>();
  }

  private assertAcceptanceCommitEnabled(commit: OutputCommitRow): void {
    if (commit.execution_kind === "acceptance" && !this.acceptanceEnabled) {
      throw new ApiError(
        404,
        "QUEUE_ACCEPTANCE_DISABLED",
        "没有找到这个接口。",
      );
    }
  }
}

function requestedInputs(job: JobRow): RequestedInput[] {
  const additional = parseAdditionalReferencesJson(
    job.additional_references_json,
    job.workflow_type,
  );
  assertUniqueAssetIds([
    job.source_asset_id,
    job.reference_asset_id,
    ...additional.map((entry) => entry.assetId),
    job.mask_asset_id,
    job.depth_asset_id,
    job.normal_asset_id,
  ]);
  return [
    ...(job.source_asset_id
      ? [{
          assetId: job.source_asset_id,
          role: "source",
          kinds: sourceAssetKindsForWorkflow(
            job.workflow_type,
            Boolean(job.mask_asset_id),
            job.purpose,
            Boolean(job.source_job_id && job.promoted_from_asset_id),
          ),
        }]
      : []),
    ...(job.reference_asset_id
      ? [{
          assetId: job.reference_asset_id,
          role: "style",
          kinds: referenceAssetKindsForWorkflow(job.workflow_type),
        }]
      : []),
    ...additional.map((entry) => ({
      assetId: entry.assetId,
      role: entry.role,
      kinds: ["reference"] as const,
    })),
    ...(job.depth_asset_id
      ? [{ assetId: job.depth_asset_id, role: "depth", kinds: ["depth"] as const }]
      : []),
    ...(job.normal_asset_id
      ? [{ assetId: job.normal_asset_id, role: "normal", kinds: ["normal"] as const }]
      : []),
  ];
}

function assertUniqueAssetIds(ids: Array<string | null>): void {
  const present = ids.filter((id): id is string => Boolean(id));
  if (new Set(present).size !== present.length) {
    throw new ApiError(
      409,
      "INVALID_PERSISTED_ASSET_GRAPH",
      "任务引用了重复资产，已安全停止处理。",
    );
  }
}

function requireAttempt(snapshot: QueueFenceSnapshot): string {
  if (!snapshot.currentAttemptId) throw staleFence();
  return snapshot.currentAttemptId;
}

function requireLeaseExpiry(snapshot: QueueFenceSnapshot): number {
  if (!snapshot.leaseExpiresAt) throw staleFence();
  return snapshot.leaseExpiresAt;
}

function validateOutputDeclaration(input: {
  uploadRequestId: string;
  providerRequestId: string | null;
  promptTemplateVersion: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  sanitizationVersion: string | null;
}): void {
  if (
    !IDENTIFIER_PATTERN.test(input.uploadRequestId) ||
    (input.providerRequestId !== null &&
      (input.providerRequestId.length < 1 || input.providerRequestId.length > 200)) ||
    input.promptTemplateVersion.length < 1 ||
    input.promptTemplateVersion.length > 100 ||
    !(SUPPORTED_MIME as readonly string[]).includes(input.mimeType) ||
    !Number.isSafeInteger(input.byteSize) ||
    input.byteSize < 1 ||
    input.byteSize > MAX_INTERNAL_OUTPUT_BYTES ||
    !SHA256_PATTERN.test(input.sha256) ||
    (input.sanitizationVersion !== null &&
      (input.sanitizationVersion.length < 1 ||
        input.sanitizationVersion.length > 100))
  ) {
    throw new ApiError(
      400,
      "INVALID_OUTPUT_DECLARATION",
      "输出登记信息无效。",
    );
  }
}

function assertSameCommit(
  commit: OutputCommitRow,
  input: {
    fence: QueueFence;
    uploadRequestId: string;
    providerRequestId: string | null;
    promptTemplateVersion: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    sanitizationVersion: string | null;
  },
  attemptId: string,
): void {
  if (
    commit.item_id !== input.fence.itemId ||
    commit.attempt_id !== attemptId ||
    commit.lease_generation !== input.fence.leaseGeneration ||
    commit.upload_request_id !== input.uploadRequestId ||
    commit.provider_request_id !== input.providerRequestId ||
    commit.prompt_template_version !== input.promptTemplateVersion ||
    commit.mime_type !== input.mimeType ||
    commit.byte_size !== input.byteSize ||
    commit.sha256 !== input.sha256 ||
    commit.sanitization_version !== input.sanitizationVersion
  ) {
    throw new ApiError(
      409,
      "OUTPUT_COMMIT_CONFLICT",
      "同一任务不能登记不同的输出文件。",
    );
  }
}

function commitMatchesTicket(
  commit: OutputCommitRow,
  claims: OutputTicketClaims,
): boolean {
  return (
    commit.id === claims.commitId &&
    commit.item_id === claims.itemId &&
    commit.attempt_id === claims.attemptId &&
    commit.lease_generation === claims.leaseGeneration &&
    commit.mime_type === claims.mimeType &&
    commit.byte_size === claims.byteSize &&
    commit.sha256 === claims.sha256
  );
}

async function r2MatchesCommit(
  object: R2ObjectBody,
  commit: OutputCommitRow,
): Promise<boolean> {
  const metadata = object.customMetadata ?? {};
  if (
    (metadata.commitId && metadata.commitId !== commit.id) ||
    (metadata.assetId && metadata.assetId !== commit.asset_id) ||
    (metadata.sha256 && metadata.sha256 !== commit.sha256) ||
    (metadata.kind && metadata.kind !== "output") ||
    (commit.execution_kind === "provider" &&
      metadata.sanitizationVersion !== commit.sanitization_version) ||
    (object.httpMetadata?.contentType &&
      object.httpMetadata.contentType !== commit.mime_type)
  ) {
    return false;
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return bytes.byteLength === commit.byte_size && sha256(bytes) === commit.sha256;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 160);
}

function extensionForMime(mimeType: string): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  throw new ApiError(400, "INVALID_OUTPUT_DECLARATION", "输出格式无效。");
}

function staleFence(): ApiError {
  return new ApiError(409, "QUEUE_FENCE_STALE", "任务租约已经失效。");
}
