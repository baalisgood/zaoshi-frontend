import type { GenerationExecutionKind } from "@/db/schema";
import type { QueueFence } from "./generation-queue";
import { ApiError, requireEnum, requireString } from "./api";

export const MAX_INTERNAL_OUTPUT_BYTES = 8 * 1024 * 1024;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u;

export const internalQueueEvents = [
  "BEGIN_PREPROCESSING",
  "BEGIN_PROVIDER_DISPATCH",
  "BEGIN_ACCEPTANCE_EXECUTION",
  "RECORD_PROVIDER_RESPONSE",
  "RECORD_ACCEPTANCE_RESULT",
  "FAIL_BEFORE_PROVIDER",
  "MARK_AMBIGUOUS",
] as const;

export type InternalQueueEvent = (typeof internalQueueEvents)[number];

export type InternalClaimInput = {
  workerId: string;
  claimRequestId: string;
  executionKind: GenerationExecutionKind;
  targetItemId?: string;
};
export type InternalHeartbeatInput = { fence: QueueFence };
export type InternalWorkRequestInput = { fence: QueueFence };
export type InternalInputReadRequest = { fence: QueueFence; ticket: string };
export type InternalOutputPrepareRequest = {
  fence: QueueFence;
  uploadRequestId: string;
  providerRequestId: string | null;
  promptTemplateVersion: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  sanitizationVersion: string | null;
};
export type InternalSweepInput =
  | { executionKind: "provider" }
  | { executionKind: "acceptance"; targetItemId: string };

export type InternalTransitionInput =
  | { fence: QueueFence; event: "BEGIN_PREPROCESSING" }
  | {
      fence: QueueFence;
      event: "BEGIN_PROVIDER_DISPATCH";
      providerAccountSlot: string;
    }
  | { fence: QueueFence; event: "BEGIN_ACCEPTANCE_EXECUTION" }
  | {
      fence: QueueFence;
      event: "RECORD_PROVIDER_RESPONSE";
      providerRequestId: string | null;
    }
  | { fence: QueueFence; event: "RECORD_ACCEPTANCE_RESULT" }
  | {
      fence: QueueFence;
      event: "FAIL_BEFORE_PROVIDER";
      errorCode: string;
      errorMessage: string;
      errorRetryable: boolean;
    }
  | {
      fence: QueueFence;
      event: "MARK_AMBIGUOUS";
      errorCode: string;
      errorMessage: string;
      providerRequestId: string | null;
    };

export function parseInternalClaimInput(
  body: Record<string, unknown>,
): InternalClaimInput {
  const acceptance = body.executionKind === "acceptance";
  assertExactKeys(
    body,
    acceptance
      ? ["workerId", "claimRequestId", "executionKind", "targetItemId"]
      : body.executionKind === undefined
        ? ["workerId", "claimRequestId"]
        : ["workerId", "claimRequestId", "executionKind"],
  );
  const workerId = boundedIdentifier(body.workerId, "workerId");
  const claimRequestId = boundedIdentifier(
    body.claimRequestId,
    "claimRequestId",
  );
  const executionKind =
    body.executionKind === undefined
      ? "provider"
      : requireEnum(body.executionKind, "executionKind", [
          "provider",
          "acceptance",
        ] as const);
  if (executionKind === "acceptance") {
    return {
      workerId,
      claimRequestId,
      executionKind,
      targetItemId: boundedIdentifier(body.targetItemId, "targetItemId"),
    };
  }
  return { workerId, claimRequestId, executionKind };
}

export function parseInternalHeartbeatInput(
  body: Record<string, unknown>,
): InternalHeartbeatInput {
  assertExactKeys(body, ["itemId", "leaseToken", "leaseGeneration"]);
  return { fence: parseFence(body) };
}

export function parseInternalWorkRequestInput(
  body: Record<string, unknown>,
): InternalWorkRequestInput {
  assertExactKeys(body, ["itemId", "leaseToken", "leaseGeneration"]);
  return { fence: parseFence(body) };
}

export function parseInternalInputReadRequest(
  body: Record<string, unknown>,
): InternalInputReadRequest {
  assertExactKeys(body, ["itemId", "leaseToken", "leaseGeneration", "ticket"]);
  return {
    fence: parseFence(body),
    ticket: requireString(body.ticket, "ticket", { min: 64, max: 4096 }),
  };
}

export function parseInternalOutputPrepareRequest(
  body: Record<string, unknown>,
): InternalOutputPrepareRequest {
  assertExactKeys(body, [
    "itemId",
    "leaseToken",
    "leaseGeneration",
    "uploadRequestId",
    "providerRequestId",
    "promptTemplateVersion",
    "mimeType",
    "byteSize",
    "sha256",
    "sanitizationVersion",
  ]);
  if (
    body.providerRequestId !== null &&
    typeof body.providerRequestId !== "string"
  ) {
    throw invalidField("providerRequestId");
  }
  if (
    body.sanitizationVersion !== null &&
    typeof body.sanitizationVersion !== "string"
  ) {
    throw invalidField("sanitizationVersion");
  }
  if (
    !Number.isSafeInteger(body.byteSize) ||
    (body.byteSize as number) < 1
  ) {
    throw invalidField("byteSize");
  }
  return {
    fence: parseFence(body),
    uploadRequestId: boundedIdentifier(body.uploadRequestId, "uploadRequestId"),
    providerRequestId:
      body.providerRequestId === null
        ? null
        : requireString(body.providerRequestId, "providerRequestId", { max: 200 }),
    promptTemplateVersion: requireString(
      body.promptTemplateVersion,
      "promptTemplateVersion",
      { max: 100 },
    ),
    mimeType: requireString(body.mimeType, "mimeType", { max: 40 }),
    byteSize: body.byteSize as number,
    sha256: requireString(body.sha256, "sha256", { min: 64, max: 64 }),
    sanitizationVersion:
      body.sanitizationVersion === null
        ? null
        : requireString(body.sanitizationVersion, "sanitizationVersion", {
            max: 100,
          }),
  };
}

export function parseInternalOutputUploadHeaders(headers: Headers): {
  fence: QueueFence;
  ticket: string;
} {
  const leaseGenerationText = headers.get("x-zaoshi-lease-generation") ?? "";
  if (!/^\d+$/u.test(leaseGenerationText)) {
    throw invalidField("leaseGeneration");
  }
  const ticket = headers.get("x-zaoshi-output-ticket") ?? "";
  return {
    fence: parseFence({
      itemId: headers.get("x-zaoshi-item-id"),
      leaseToken: headers.get("x-zaoshi-lease-token"),
      leaseGeneration: Number(leaseGenerationText),
    }),
    ticket: requireString(ticket, "ticket", { min: 64, max: 4096 }),
  };
}

export function parseInternalTransitionInput(
  body: Record<string, unknown>,
): InternalTransitionInput {
  const event = requireEnum(
    body.event,
    "event",
    internalQueueEvents,
  );
  const fence = parseFence(body);

  switch (event) {
    case "BEGIN_PREPROCESSING":
      assertExactKeys(body, [
        "itemId",
        "leaseToken",
        "leaseGeneration",
        "event",
      ]);
      return { fence, event };
    case "BEGIN_PROVIDER_DISPATCH":
      assertExactKeys(body, [
        "itemId",
        "leaseToken",
        "leaseGeneration",
        "event",
        "providerAccountSlot",
      ]);
      return {
        fence,
        event,
        providerAccountSlot: boundedIdentifier(
          body.providerAccountSlot,
          "providerAccountSlot",
        ),
      };
    case "BEGIN_ACCEPTANCE_EXECUTION":
      assertExactKeys(body, [
        "itemId",
        "leaseToken",
        "leaseGeneration",
        "event",
      ]);
      return { fence, event };
    case "RECORD_PROVIDER_RESPONSE":
      assertExactKeys(body, [
        "itemId",
        "leaseToken",
        "leaseGeneration",
        "event",
        "providerRequestId",
      ]);
      return {
        fence,
        event,
        providerRequestId:
          body.providerRequestId === null
            ? null
            : requireString(body.providerRequestId, "providerRequestId", {
                max: 200,
              }),
      };
    case "RECORD_ACCEPTANCE_RESULT":
      assertExactKeys(body, [
        "itemId",
        "leaseToken",
        "leaseGeneration",
        "event",
      ]);
      return { fence, event };
    case "FAIL_BEFORE_PROVIDER":
      assertExactKeys(body, [
        "itemId",
        "leaseToken",
        "leaseGeneration",
        "event",
        "errorCode",
        "errorMessage",
        "errorRetryable",
      ]);
      if (typeof body.errorRetryable !== "boolean") {
        throw invalidField("errorRetryable");
      }
      return {
        fence,
        event,
        errorCode: boundedIdentifier(body.errorCode, "errorCode"),
        errorMessage: requireString(body.errorMessage, "errorMessage", {
          max: 500,
        }),
        errorRetryable: body.errorRetryable,
      };
    case "MARK_AMBIGUOUS":
      assertExactKeys(body, [
        "itemId",
        "leaseToken",
        "leaseGeneration",
        "event",
        "errorCode",
        "errorMessage",
        "providerRequestId",
      ]);
      return {
        fence,
        event,
        errorCode: boundedIdentifier(body.errorCode, "errorCode"),
        errorMessage: requireString(body.errorMessage, "errorMessage", {
          max: 500,
        }),
        providerRequestId:
          body.providerRequestId == null
            ? null
            : requireString(body.providerRequestId, "providerRequestId", {
                max: 200,
              }),
      };
  }
}

export function parseInternalSweepInput(
  body: Record<string, unknown>,
): InternalSweepInput {
  if (body.executionKind === undefined) {
    assertExactKeys(body, []);
    return { executionKind: "provider" };
  }
  if (body.executionKind !== "acceptance") throw invalidField("executionKind");
  assertExactKeys(body, ["executionKind", "targetItemId"]);
  return {
    executionKind: "acceptance",
    targetItemId: boundedIdentifier(body.targetItemId, "targetItemId"),
  };
}

function parseFence(body: Record<string, unknown>): QueueFence {
  const leaseGeneration = body.leaseGeneration;
  if (
    !Number.isSafeInteger(leaseGeneration) ||
    (leaseGeneration as number) < 1
  ) {
    throw invalidField("leaseGeneration");
  }
  return {
    itemId: boundedIdentifier(body.itemId, "itemId"),
    leaseToken: boundedIdentifier(body.leaseToken, "leaseToken"),
    leaseGeneration: leaseGeneration as number,
  };
}

function boundedIdentifier(value: unknown, field: string): string {
  const normalized = requireString(value, field, { max: 128 });
  if (!IDENTIFIER_PATTERN.test(normalized)) throw invalidField(field);
  return normalized;
}

function assertExactKeys(
  body: Record<string, unknown>,
  expected: readonly string[],
): void {
  const expectedSet = new Set(expected);
  if (
    Object.keys(body).length !== expectedSet.size ||
    Object.keys(body).some((key) => !expectedSet.has(key))
  ) {
    throw new ApiError(
      400,
      "INVALID_INTERNAL_QUEUE_BODY",
      "内部队列请求包含缺失或不受支持的字段。",
    );
  }
}

function invalidField(field: string): ApiError {
  return new ApiError(400, "INVALID_FIELD", `${field} 的值不受支持。`, {
    field,
  });
}
