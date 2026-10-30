import type { GenerationWorkSpec as InternalWorkSpec } from "@/lib/domain/generation-work";
import type { GenerationExecutionKind } from "@/db/schema";
import type { QueueFence } from "@/lib/server/generation-queue";
import type { InternalTransitionInput } from "@/lib/server/internal-queue-contract";
import type { AiErrorCode } from "@/lib/ai";

export type ConsumerClaim = {
  item: {
    id: string;
    jobId: string;
    ordinal: number;
    leaseExpiresAt: number;
    executionKind: GenerationExecutionKind;
  };
  attemptId: string;
  fence: QueueFence;
};

export type DownloadedInput = {
  role: string;
  index: number;
  mimeType: string;
  bytes: Uint8Array;
};

export type ExecutorOutput = {
  bytes: Uint8Array;
  mimeType: string;
  providerRequestId: string | null;
  promptTemplateVersion: string;
  sanitizationVersion: string | null;
};

export type PreparedGeneration = {
  provider: "seedream" | "qwen" | "google" | "openai" | "acceptance";
  model: string;
  accountSlotId: string;
  execute(): Promise<ExecutorOutput>;
};

export class GenerationExecutionError extends Error {
  readonly code: AiErrorCode;

  constructor(
    readonly providerRequestId: string | null,
    options?: { cause?: unknown; code?: AiErrorCode },
  ) {
    super("GENERATION_EXECUTION_FAILED", options);
    this.name = "GenerationExecutionError";
    this.code = options?.code ?? "PROVIDER_ERROR";
  }
}

export type SpoolRecord = {
  version: 1;
  executionKind: GenerationExecutionKind;
  attemptId: string;
  fence: QueueFence;
  uploadRequestId: string;
  providerRequestId: string | null;
  promptTemplateVersion: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  sanitizationVersion: string | null;
};

export interface ConsumerControlPlane {
  claim(workerId: string, claimRequestId: string): Promise<ConsumerClaim | null>;
  heartbeat(fence: QueueFence): Promise<"applied" | "already_applied">;
  transition(
    input: InternalTransitionInput,
  ): Promise<"applied" | "already_applied">;
  work(fence: QueueFence): Promise<InternalWorkSpec>;
  input(
    fence: QueueFence,
    ticket: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; sha256: string }>;
  prepareOutput(input: {
    fence: QueueFence;
    uploadRequestId: string;
    providerRequestId: string | null;
    promptTemplateVersion: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    sanitizationVersion: string | null;
  }): Promise<{ commitId: string; ticket: string | null; result?: "rejected" }>;
  uploadOutput(
    fence: QueueFence,
    ticket: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<"applied" | "already_applied" | "moderation_pending" | "rejected">;
}

export type SweepSummary = {
  retried: number;
  failed: number;
  reconciliationRequired: number;
  outputsRecovered?: number;
  outputReconciliationRequired?: number;
};

export interface ConsumerMaintenanceControlPlane {
  sweep(): Promise<SweepSummary>;
}

export interface GenerationExecutor {
  prepare(
    work: InternalWorkSpec,
    inputs: readonly DownloadedInput[],
  ): Promise<PreparedGeneration>;
}

export interface ConsumerSpool {
  list(): Promise<SpoolRecord[]>;
  read(record: SpoolRecord): Promise<Uint8Array>;
  save(record: SpoolRecord, bytes: Uint8Array): Promise<void>;
  remove(record: SpoolRecord): Promise<void>;
  quarantine(
    record: SpoolRecord,
    reason: "invalid-local-record" | "terminal-control-plane",
  ): Promise<void>;
}

export type SpoolMaintenanceSummary = {
  inspected: number;
  removed: number;
  retained: number;
  retainedBytes: number;
};

export interface ConsumerSpoolMaintenance {
  maintainQuarantine(input: {
    nowMs: number;
    retentionMs: number;
    maxEntries: number;
    maxBytes: number;
  }): Promise<SpoolMaintenanceSummary>;
}
