import { createHash } from "node:crypto";
import type {
  DownloadedInput,
  GenerationExecutor,
  PreparedGeneration,
} from "@/lib/consumer/contracts";
import {
  ACCEPTANCE_ACCOUNT_SLOT,
  ACCEPTANCE_FIXTURE_BYTE_SIZE,
  ACCEPTANCE_FIXTURE_MIME_TYPE,
  ACCEPTANCE_FIXTURE_SHA256,
  ACCEPTANCE_MODEL,
  ACCEPTANCE_PROMPT_VERSION,
  ACCEPTANCE_PROVIDER,
} from "@/lib/domain/acceptance-fixture";

const FIXTURE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAADQ0lEQVR42u3UIQEAAAjAMPonReAIAD1gYgUuHlk9AB+FCIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIGCAIgAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYICAAQoBGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAgYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggIABigAYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECBigEYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCBgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIGKAJggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIGKAQgAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIGCAAAYIYIAA1y1OUrhsn9LtngAAAABJRU5ErkJggg==";

export const ACCEPTANCE_FIXTURE_BYTES = new Uint8Array(
  Buffer.from(FIXTURE_BASE64, "base64"),
);
if (
  ACCEPTANCE_FIXTURE_BYTES.byteLength !== ACCEPTANCE_FIXTURE_BYTE_SIZE ||
  createHash("sha256").update(ACCEPTANCE_FIXTURE_BYTES).digest("hex") !==
    ACCEPTANCE_FIXTURE_SHA256
) {
  throw new Error("ACCEPTANCE_FIXTURE_METADATA_INVALID");
}

export {
  ACCEPTANCE_ACCOUNT_SLOT,
  ACCEPTANCE_FIXTURE_SHA256,
  ACCEPTANCE_MODEL,
  ACCEPTANCE_PROMPT_VERSION,
  ACCEPTANCE_PROVIDER,
};

export function createAcceptanceGenerationExecutor(): GenerationExecutor {
  return {
    async prepare(work, inputs): Promise<PreparedGeneration> {
      assertAcceptanceWork(work, inputs);
      return {
        provider: ACCEPTANCE_PROVIDER,
        model: ACCEPTANCE_MODEL,
        accountSlotId: ACCEPTANCE_ACCOUNT_SLOT,
        async execute() {
          return {
            bytes: ACCEPTANCE_FIXTURE_BYTES.slice(),
            mimeType: ACCEPTANCE_FIXTURE_MIME_TYPE,
            providerRequestId: null,
            promptTemplateVersion: ACCEPTANCE_PROMPT_VERSION,
            sanitizationVersion: null,
          };
        },
      };
    },
  };
}

function assertAcceptanceWork(
  work: Parameters<GenerationExecutor["prepare"]>[0],
  inputs: readonly DownloadedInput[],
): void {
  if (
    work.executionKind !== "acceptance" ||
    work.providerPreference !== ACCEPTANCE_MODEL ||
    work.inputs.length !== 1 ||
    inputs.length !== 1 ||
    work.inputs[0]?.role !== "source" ||
    inputs[0]?.role !== "source" ||
    inputs[0].index !== 0 ||
    inputs[0].mimeType !== ACCEPTANCE_FIXTURE_MIME_TYPE ||
    inputs[0].bytes.byteLength !== ACCEPTANCE_FIXTURE_BYTES.byteLength ||
    createHash("sha256").update(inputs[0].bytes).digest("hex") !==
      ACCEPTANCE_FIXTURE_SHA256
  ) {
    throw new Error("ACCEPTANCE_FIXTURE_CONFLICT");
  }
}
