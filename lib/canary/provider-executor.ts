import { createHash } from "node:crypto";
import type { GenerationWorkSpec } from "@/lib/domain/generation-work";
import {
  createDomesticGenerationExecutor,
  type DomesticAccountSlot,
} from "@/lib/consumer/domestic-executor";
import type {
  DownloadedInput,
  GenerationExecutor,
  PreparedGeneration,
} from "@/lib/consumer/contracts";
import {
  PROVIDER_CANARY_FIXTURE_BYTE_SIZE,
  PROVIDER_CANARY_FIXTURE_MIME_TYPE,
  PROVIDER_CANARY_FIXTURE_SHA256,
  PROVIDER_CANARY_MODEL,
} from "./provider-fixture";
import { PROVIDER_CANARY_IDENTITY } from "./provider-store";
import { nodeImageSanitizer } from "@/lib/platform/node-image-sanitizer";

export function createProviderCanaryExecutor(options: {
  slot: Extract<DomesticAccountSlot, { provider: "seedream" }>;
  fetch: typeof globalThis.fetch;
  providerRequestTimeoutMs?: number;
}): GenerationExecutor {
  const delegate = createDomesticGenerationExecutor({
    slots: { seedream: options.slot },
    fetch: options.fetch,
    sanitizer: nodeImageSanitizer,
    providerRequestTimeoutMs: options.providerRequestTimeoutMs,
  });
  return {
    async prepare(
      work: GenerationWorkSpec,
      inputs: readonly DownloadedInput[],
    ): Promise<PreparedGeneration> {
      assertAuthorizedCanaryWork(work, inputs);
      return delegate.prepare(work, inputs);
    },
  };
}

function assertAuthorizedCanaryWork(
  work: GenerationWorkSpec,
  inputs: readonly DownloadedInput[],
): void {
  const expectedWork =
    work.version === 1 &&
    work.executionKind === "provider" &&
    work.itemId === PROVIDER_CANARY_IDENTITY.itemId &&
    work.providerPreference === PROVIDER_CANARY_MODEL &&
    work.workflowType === "concept" &&
    work.spaceType === "unspecified" &&
    work.purpose === "final" &&
    work.resolution === "2K" &&
    work.aspectRatio === "1:1" &&
    work.quality === "draft" &&
    work.visualRealism === "photorealistic" &&
    work.stylePresetId === "modern-minimalist" &&
    work.lightingPreset === "noon" &&
    work.lampState === "mixed" &&
    work.colorTemperatureKelvin === 4000 &&
    work.renovationScope === "replace-soft-furnishings" &&
    work.promotedFromPreview === false &&
    work.editInstruction === null &&
    work.customPrompt === null &&
    work.advancedSettings === null &&
    work.outputCount === 1 &&
    work.totalOutputs === 1 &&
    work.outputOrdinal === 0;
  const declared = work.inputs[0];
  const downloaded = inputs[0];
  const expectedInput =
    work.inputs.length === 1 &&
    inputs.length === 1 &&
    declared?.role === "source" &&
    declared.index === 0 &&
    declared.mimeType === PROVIDER_CANARY_FIXTURE_MIME_TYPE &&
    declared.byteSize === PROVIDER_CANARY_FIXTURE_BYTE_SIZE &&
    declared.sha256 === PROVIDER_CANARY_FIXTURE_SHA256 &&
    downloaded?.role === "source" &&
    downloaded.index === 0 &&
    downloaded.mimeType === PROVIDER_CANARY_FIXTURE_MIME_TYPE &&
    downloaded.bytes.byteLength === PROVIDER_CANARY_FIXTURE_BYTE_SIZE &&
    digest(downloaded.bytes) === PROVIDER_CANARY_FIXTURE_SHA256;
  if (!expectedWork || !expectedInput) {
    throw new Error("PROVIDER_CANARY_WORK_CONFLICT");
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
