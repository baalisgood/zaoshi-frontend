import { createHash } from "node:crypto";
import { createSignedInternalQueueHeaders } from "@/lib/server/internal-queue-auth";
import {
  parseGenerationWorkSpec,
  type GenerationWorkSpec as InternalWorkSpec,
} from "@/lib/domain/generation-work";
import type { QueueFence } from "@/lib/server/generation-queue";
import type { InternalTransitionInput } from "@/lib/server/internal-queue-contract";
import type {
  ConsumerClaim,
  ConsumerControlPlane,
  ConsumerMaintenanceControlPlane,
  SweepSummary,
} from "./contracts";
import type { GenerationExecutionKind } from "@/db/schema";
import {
  normalizeInternalControlPlaneBaseUrl,
  type InternalControlPlaneTransport,
} from "@/lib/domain/internal-control-plane";

const MAX_JSON_RESPONSE_BYTES = 64 * 1024;
const MAX_INPUT_RESPONSE_BYTES = 12 * 1024 * 1024;

export class ConsumerControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`CONTROL_PLANE_${status}_${code}`);
    this.name = "ConsumerControlPlaneError";
  }
}

export class HttpConsumerControlPlane
  implements ConsumerControlPlane, ConsumerMaintenanceControlPlane
{
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly credentials: {
      keyId: string;
      secret: string;
      audience: string;
    },
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    transport: InternalControlPlaneTransport = "https",
    private readonly executionKind: GenerationExecutionKind = "provider",
    private readonly targetItemId: string | null = null,
  ) {
    this.baseUrl = new URL(normalizeInternalControlPlaneBaseUrl(baseUrl, transport));
    if (
      (this.executionKind === "acceptance") !==
      (this.targetItemId !== null)
    ) {
      throw new Error("CONTROL_PLANE_ACCEPTANCE_TARGET_INVALID");
    }
    if (
      this.targetItemId !== null &&
      !/^[A-Za-z0-9:_-]{1,128}$/u.test(this.targetItemId)
    ) {
      throw new Error("CONTROL_PLANE_ACCEPTANCE_TARGET_INVALID");
    }
  }

  async claim(
    workerId: string,
    claimRequestId: string,
  ): Promise<ConsumerClaim | null> {
    const response = await this.postJson("/api/internal/generation/claim", {
      workerId,
      claimRequestId,
      executionKind: this.executionKind,
      ...(this.targetItemId === null ? {} : { targetItemId: this.targetItemId }),
    });
    if (response.status === 204) return null;
    const body = await readJson(response, MAX_JSON_RESPONSE_BYTES);
    return parseConsumerClaim(body.claim);
  }

  async sweep(): Promise<SweepSummary> {
    const response = await this.postJson(
      "/api/internal/generation/sweep",
      this.executionKind === "acceptance" && this.targetItemId !== null
        ? { executionKind: "acceptance", targetItemId: this.targetItemId }
        : {},
    );
    const body = await readJson(response, MAX_JSON_RESPONSE_BYTES);
    const summary = requireObject(body.summary);
    const allowed = new Set([
      "retried",
      "failed",
      "reconciliationRequired",
      "outputsRecovered",
      "outputReconciliationRequired",
    ]);
    if (Object.keys(summary).some((key) => !allowed.has(key))) {
      throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
    }
    const result: SweepSummary = {
      retried: requireSafeCount(summary.retried),
      failed: requireSafeCount(summary.failed),
      reconciliationRequired: requireSafeCount(summary.reconciliationRequired),
    };
    if (summary.outputsRecovered !== undefined) {
      result.outputsRecovered = requireSafeCount(summary.outputsRecovered);
    }
    if (summary.outputReconciliationRequired !== undefined) {
      result.outputReconciliationRequired = requireSafeCount(
        summary.outputReconciliationRequired,
      );
    }
    return result;
  }

  async heartbeat(fence: QueueFence): Promise<"applied" | "already_applied"> {
    const response = await this.postJson(
      "/api/internal/generation/heartbeat",
      fence,
    );
    return readMutationResult(response);
  }

  async transition(
    input: InternalTransitionInput,
  ): Promise<"applied" | "already_applied"> {
    const response = await this.postJson(
      "/api/internal/generation/transition",
      { ...input.fence, ...withoutFence(input) },
    );
    return readMutationResult(response);
  }

  async work(fence: QueueFence): Promise<InternalWorkSpec> {
    const response = await this.postJson(
      "/api/internal/generation/work",
      fence,
    );
    const body = await readJson(response, MAX_JSON_RESPONSE_BYTES);
    return parseGenerationWorkSpec(body.work);
  }

  async input(
    fence: QueueFence,
    ticket: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string; sha256: string }> {
    const response = await this.postJson(
      "/api/internal/generation/input",
      { ...fence, ticket },
    );
    await requireOk(response);
    const mimeType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
      throw new Error("CONTROL_PLANE_INPUT_MIME_INVALID");
    }
    const bytes = await readBytes(response, MAX_INPUT_RESPONSE_BYTES);
    const sha256 = digest(bytes);
    if (response.headers.get("x-zaoshi-content-sha256") !== sha256) {
      throw new Error("CONTROL_PLANE_INPUT_INTEGRITY");
    }
    return { bytes, mimeType, sha256 };
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
  }): Promise<{ commitId: string; ticket: string | null; result?: "rejected" }> {
    const response = await this.postJson(
      "/api/internal/generation/output-prepare",
      { ...input.fence, ...withoutFence(input) },
    );
    const body = await readJson(response, MAX_JSON_RESPONSE_BYTES);
    const commit = requireObject(body.commit);
    if (typeof commit.commitId !== "string") {
      throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
    }
    if (commit.ticket !== null && typeof commit.ticket !== "string") {
      throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
    }
    if (commit.ticket === null && !["already_committed","rejected"].includes(String(commit.result))) throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
    return { commitId: commit.commitId, ticket: commit.ticket, ...(commit.result === "rejected" ? {result:"rejected" as const}: {}) };
  }

  async uploadOutput(
    fence: QueueFence,
    ticket: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<"applied" | "already_applied" | "moderation_pending" | "rejected"> {
    const pathname = "/api/internal/generation/output";
    const headers = await this.signedHeaders(pathname, bytes, mimeType);
    headers.set("x-zaoshi-item-id", fence.itemId);
    headers.set("x-zaoshi-lease-token", fence.leaseToken);
    headers.set("x-zaoshi-lease-generation", String(fence.leaseGeneration));
    headers.set("x-zaoshi-output-ticket", ticket);
    const stable = new Uint8Array(bytes.byteLength);
    stable.set(bytes);
    const response = await this.fetchImplementation(
      new URL(pathname, this.baseUrl),
      {
        method: "POST",
        headers,
        body: stable.buffer,
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      },
    );
    const body = await readJson(response, MAX_JSON_RESPONSE_BYTES);
    const output = requireObject(body.output);
    if (output.result === "moderation_pending" || output.result === "rejected") return output.result;
    return requireMutationResult(output.result);
  }

  private async postJson(
    pathname: string,
    value: Record<string, unknown>,
  ): Promise<Response> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const headers = await this.signedHeaders(
      pathname,
      bytes,
      "application/json",
    );
    const stable = new Uint8Array(bytes.byteLength);
    stable.set(bytes);
    return this.fetchImplementation(new URL(pathname, this.baseUrl), {
      method: "POST",
      headers,
      body: stable.buffer,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  }

  private signedHeaders(
    pathname: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<Headers> {
    return createSignedInternalQueueHeaders({
      ...this.credentials,
      method: "POST",
      pathname,
      body,
      contentType,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: crypto.randomUUID().replaceAll("-", ""),
    });
  }
}

async function readMutationResult(
  response: Response,
): Promise<"applied" | "already_applied"> {
  const body = await readJson(response, MAX_JSON_RESPONSE_BYTES);
  return requireMutationResult(body.result);
}

function requireMutationResult(
  value: unknown,
): "applied" | "already_applied" {
  if (value === "applied" || value === "already_applied") return value;
  if (value === "stale") {
    throw new ConsumerControlPlaneError(409, "QUEUE_FENCE_STALE");
  }
  if (value === "conflict") {
    throw new ConsumerControlPlaneError(409, "QUEUE_STATE_CONFLICT");
  }
  throw new Error("CONTROL_PLANE_MUTATION_REJECTED");
}

async function readJson(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  await requireOk(response);
  const bytes = await readBytes(response, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
  }
  return requireObject(value);
}

async function requireOk(response: Response): Promise<void> {
  if (!response.ok) {
    let code = "HTTP_ERROR";
    try {
      const bytes = await readBytes(response, MAX_JSON_RESPONSE_BYTES);
      const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        const error = (decoded as Record<string, unknown>).error;
        if (error && typeof error === "object" && !Array.isArray(error)) {
          const candidate = (error as Record<string, unknown>).code;
          if (
            typeof candidate === "string" &&
            /^[A-Z0-9_]{1,80}$/u.test(candidate)
          ) {
            code = candidate;
          }
        }
      }
    } catch {
      // Never copy an internal response body into logs or exception text.
    }
    throw new ConsumerControlPlaneError(response.status, code);
  }
}

async function readBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredText = response.headers.get("content-length");
  const declared = declaredText === null ? null : Number(declaredText);
  if (
    declared !== null &&
    (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)
  ) {
    throw new Error("CONTROL_PLANE_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("CONTROL_PLANE_RESPONSE_TOO_LARGE");
    }
    chunks.push(part.value);
  }
  if (declared !== null && declared !== total) {
    throw new Error("CONTROL_PLANE_RESPONSE_LENGTH_MISMATCH");
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function requireSafeCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
  }
  return value as number;
}

function parseConsumerClaim(value: unknown): ConsumerClaim {
  const claim = requireObject(value);
  const item = requireObject(claim.item);
  const fence = requireObject(claim.fence);
  if (
    !isControlIdentifier(item.id) ||
    !isControlIdentifier(item.jobId) ||
    !Number.isSafeInteger(item.ordinal) ||
    (item.ordinal as number) < 0 ||
    !Number.isSafeInteger(item.leaseExpiresAt) ||
    (item.executionKind !== "provider" && item.executionKind !== "acceptance") ||
    !isControlIdentifier(claim.attemptId) ||
    !isControlIdentifier(fence.itemId) ||
    !isControlIdentifier(fence.leaseToken) ||
    !Number.isSafeInteger(fence.leaseGeneration) ||
    (fence.leaseGeneration as number) < 1 ||
    fence.itemId !== item.id
  ) {
    throw new Error("CONTROL_PLANE_RESPONSE_INVALID");
  }
  return {
    item: {
      id: item.id,
      jobId: item.jobId,
      ordinal: item.ordinal as number,
      leaseExpiresAt: item.leaseExpiresAt as number,
      executionKind: item.executionKind,
    },
    attemptId: claim.attemptId,
    fence: {
      itemId: fence.itemId,
      leaseToken: fence.leaseToken,
      leaseGeneration: fence.leaseGeneration as number,
    },
  };
}

function isControlIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,160}$/u.test(value);
}

function withoutFence<T extends { fence: QueueFence }>(
  input: T,
): Omit<T, "fence"> {
  const { fence, ...rest } = input;
  void fence;
  return rest;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
