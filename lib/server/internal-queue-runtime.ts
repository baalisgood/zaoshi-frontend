import { getD1Binding } from "@/db";
import { getR2Binding } from "@/db";
import { readRuntimeBindings } from "@/lib/platform/cloudflare-runtime";
import { ApiError } from "./api";
import {
  resolveInternalQueueAuthConfig,
  type InternalQueueAuthConfig,
} from "./internal-queue-auth";
import {
  assertInternalQueueTicketSecretIsIndependent,
  resolveInternalQueueTicketConfig,
  type InternalQueueTicketConfig,
} from "./internal-queue-ticket";
import { requirePrivateTestConfig, type PrivateTestConfig } from "./private-test";

export type InternalQueueRuntime = {
  auth: InternalQueueAuthConfig;
  d1: D1Database | null;
  r2: R2Bucket | null;
  ticket: InternalQueueTicketConfig | null;
  leaseSeconds: number;
  ownerConcurrency: number;
  providerConcurrency: number;
  sweepLimit: number;
  acceptanceEnabled: boolean;
  privateTest?: PrivateTestConfig | null;
};

export function readInternalQueueRuntime(): InternalQueueRuntime {
  const bindings = readRuntimeBindings();
  const privateTest = requirePrivateTestConfig(bindings);
  const auth = resolveInternalQueueAuthConfig(bindings);
  if (bindings.GENERATION_QUEUE_ACCEPTANCE_ENABLED === "1" && !(bindings.BACKEND_PROFILE === "sites-demo" && bindings.AUTH_MODE === "demo" && bindings.PUBLIC_IMAGE_GENERATION_ENABLED === "0")) throw new ApiError(503,"QUEUE_ACCEPTANCE_PROFILE_INVALID","验收 fixture 仅可用于隔离演示环境。");
  if (!auth.enabled) {
    return {
      auth,
      d1: null,
      r2: null,
      ticket: null,
      leaseSeconds: 180,
      ownerConcurrency: 1,
      providerConcurrency: 1,
      sweepLimit: 50,
      acceptanceEnabled: false,
      privateTest: null,
    };
  }
  const ticket =
    typeof bindings.GENERATION_INTERNAL_TICKET_SECRET === "string" &&
    bindings.GENERATION_INTERNAL_TICKET_SECRET.trim()
      ? resolveInternalQueueTicketConfig(bindings)
      : null;
  assertInternalQueueTicketSecretIsIndependent(
    ticket,
    [...auth.keys.values()].map((key) => key.secret),
  );
  return {
    auth,
    d1: getD1Binding(),
    r2: getR2Binding(),
    ticket,
    leaseSeconds: boundedInteger(
      bindings.GENERATION_QUEUE_LEASE_SECONDS,
      180,
      30,
      900,
    ),
    ownerConcurrency: boundedInteger(
      bindings.GENERATION_QUEUE_OWNER_CONCURRENCY,
      privateTest ? 1 : 3,
      1,
      16,
    ),
    providerConcurrency: boundedInteger(
      bindings.GENERATION_QUEUE_PROVIDER_CONCURRENCY,
      privateTest ? 1 : 3,
      1,
      32,
    ),
    sweepLimit: boundedInteger(
      bindings.GENERATION_QUEUE_SWEEP_LIMIT,
      50,
      1,
      100,
    ),
    acceptanceEnabled: strictBoolean(
      bindings.GENERATION_QUEUE_ACCEPTANCE_ENABLED,
      "GENERATION_QUEUE_ACCEPTANCE_ENABLED",
    ),
    privateTest,
  };
}

function strictBoolean(value: unknown, name: string): boolean {
  if (value === undefined || value === null || value === "" || value === "0") {
    return false;
  }
  if (value === "1") return true;
  throw new ApiError(
    503,
    "INTERNAL_QUEUE_CONFIG_INVALID",
    `${name} 配置无效。`,
  );
}

export function requireInternalQueueR2(
  runtime: InternalQueueRuntime,
): R2Bucket {
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
  return runtime.r2;
}

export function requireInternalQueueTicket(
  runtime: InternalQueueRuntime,
): InternalQueueTicketConfig {
  if (!runtime.auth.enabled) {
    throw new ApiError(404, "NOT_FOUND", "没有找到这个接口。");
  }
  if (!runtime.ticket) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_TICKET_MISCONFIGURED",
      "内部任务票据尚未配置。",
    );
  }
  return runtime.ticket;
}

export function requireInternalQueueD1(
  runtime: InternalQueueRuntime,
): D1Database {
  if (!runtime.auth.enabled) {
    throw new ApiError(404, "NOT_FOUND", "没有找到这个接口。");
  }
  if (!runtime.d1) {
    throw new ApiError(
      503,
      "QUEUE_REQUIRES_D1",
      "内部持久任务队列需要 D1。",
    );
  }
  return runtime.d1;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value !== "string" ||
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_CONFIG_INVALID",
      "内部队列运行参数配置无效。",
    );
  }
  return Number(value);
}
