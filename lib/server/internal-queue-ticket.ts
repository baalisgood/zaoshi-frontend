import { ApiError } from "./api";
import type { QueueFence } from "./generation-queue";

const TOKEN_VERSION = "v1";
const SECRET_MIN_BYTES = 32;
const SECRET_MAX_BYTES = 256;
const MAX_TICKET_TTL_SECONDS = 5 * 60;
const MIN_TICKET_TTL_SECONDS = 2 * 60;
const CLOCK_SKEW_SECONDS = 15;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type InternalQueueTicketConfig = {
  audience: string;
  secret: string;
  ttlSeconds: number;
};

type TicketPurpose = "input" | "output";

type BaseTicketClaims = {
  v: 1;
  aud: string;
  purpose: TicketPurpose;
  method: "POST";
  path: string;
  itemId: string;
  attemptId: string;
  leaseTokenHash: string;
  leaseGeneration: number;
  nbf: number;
  exp: number;
  jti: string;
};

export type InputTicketClaims = BaseTicketClaims & {
  purpose: "input";
  assetId: string;
  role: string;
  index: number;
  mimeType: string;
  byteSize: number;
  sha256: string;
};

export type OutputTicketClaims = BaseTicketClaims & {
  purpose: "output";
  commitId: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
};

export function resolveInternalQueueTicketConfig(
  environment: Record<string, unknown>,
): InternalQueueTicketConfig {
  const secret = requiredString(
    environment.GENERATION_INTERNAL_TICKET_SECRET,
    "GENERATION_INTERNAL_TICKET_SECRET",
  );
  const secretBytes = new TextEncoder().encode(secret).byteLength;
  if (secretBytes < SECRET_MIN_BYTES || secretBytes > SECRET_MAX_BYTES) {
    throw invalidConfiguration();
  }
  const audience = requiredString(
    environment.GENERATION_INTERNAL_AUDIENCE,
    "GENERATION_INTERNAL_AUDIENCE",
  );
  if (!IDENTIFIER_PATTERN.test(audience)) throw invalidConfiguration();
  const ttlSeconds = boundedInteger(
    environment.GENERATION_INTERNAL_TICKET_TTL_SECONDS,
    240,
    MIN_TICKET_TTL_SECONDS,
    MAX_TICKET_TTL_SECONDS,
  );
  return { audience, secret, ttlSeconds };
}

export function assertInternalQueueTicketSecretIsIndependent(
  config: InternalQueueTicketConfig | null,
  machineSecrets: Iterable<string>,
): void {
  if (
    config &&
    [...machineSecrets].some((secret) => secret === config.secret)
  ) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_SECRET_REUSE",
      "内部机器认证和短时票据必须使用不同密钥。",
    );
  }
}

export async function createInputTicket(input: {
  config: InternalQueueTicketConfig;
  fence: QueueFence;
  attemptId: string;
  assetId: string;
  role: string;
  index: number;
  mimeType: string;
  byteSize: number;
  sha256: string;
  leaseExpiresAt: number;
  nowSeconds?: number;
  jti?: string;
}): Promise<string> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return signTicket(
    {
      ...(await baseClaims(
        input.config,
        "input",
        "/api/internal/generation/input",
        input.fence,
        input.attemptId,
        input.leaseExpiresAt,
        nowSeconds,
        input.jti,
      )),
      purpose: "input",
      assetId: input.assetId,
      role: input.role,
      index: input.index,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
    },
    input.config.secret,
  );
}

export async function createOutputTicket(input: {
  config: InternalQueueTicketConfig;
  fence: QueueFence;
  attemptId: string;
  commitId: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  leaseExpiresAt: number;
  nowSeconds?: number;
  jti?: string;
}): Promise<string> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  return signTicket(
    {
      ...(await baseClaims(
        input.config,
        "output",
        "/api/internal/generation/output",
        input.fence,
        input.attemptId,
        input.leaseExpiresAt,
        nowSeconds,
        input.jti,
      )),
      purpose: "output",
      commitId: input.commitId,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
    },
    input.config.secret,
  );
}

export async function verifyInputTicket(
  token: string,
  config: InternalQueueTicketConfig,
  fence: QueueFence,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<InputTicketClaims> {
  const claims = await verifyTicket(token, config, "input", nowSeconds);
  if (!isInputClaims(claims) || !(await ticketMatchesFence(claims, fence))) {
    throw invalidTicket();
  }
  return claims;
}

export async function verifyOutputTicket(
  token: string,
  config: InternalQueueTicketConfig,
  fence: QueueFence,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<OutputTicketClaims> {
  const claims = await verifyTicket(token, config, "output", nowSeconds);
  if (!isOutputClaims(claims) || !(await ticketMatchesFence(claims, fence))) {
    throw invalidTicket();
  }
  return claims;
}

async function baseClaims(
  config: InternalQueueTicketConfig,
  purpose: TicketPurpose,
  path: string,
  fence: QueueFence,
  attemptId: string,
  leaseExpiresAt: number,
  nowSeconds: number,
  jti = crypto.randomUUID(),
): Promise<BaseTicketClaims> {
  const exp = nowSeconds + config.ttlSeconds;
  if (leaseExpiresAt <= nowSeconds || !IDENTIFIER_PATTERN.test(attemptId)) {
    throw new ApiError(409, "QUEUE_FENCE_STALE", "任务租约已经失效。");
  }
  return {
    v: 1,
    aud: config.audience,
    purpose,
    method: "POST",
    path,
    itemId: fence.itemId,
    attemptId,
    leaseTokenHash: await sha256Hex(fence.leaseToken),
    leaseGeneration: fence.leaseGeneration,
    nbf: nowSeconds,
    exp,
    jti,
  };
}

async function signTicket(
  claims: InputTicketClaims | OutputTicketClaims,
  secret: string,
): Promise<string> {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = await hmac(secret, `${TOKEN_VERSION}.${payload}`, "sign");
  return `${TOKEN_VERSION}.${payload}.${bytesToBase64Url(signature)}`;
}

async function verifyTicket(
  token: string,
  config: InternalQueueTicketConfig,
  purpose: TicketPurpose,
  nowSeconds: number,
): Promise<unknown> {
  if (token.length > 4096) throw invalidTicket();
  const [version, payload, signature, extra] = token.split(".");
  if (version !== TOKEN_VERSION || !payload || !signature || extra) {
    throw invalidTicket();
  }
  let signatureBytes: Uint8Array;
  let decoded: unknown;
  try {
    signatureBytes = base64UrlToBytes(signature);
    decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
  } catch {
    throw invalidTicket();
  }
  const valid = await hmac(
    config.secret,
    `${TOKEN_VERSION}.${payload}`,
    "verify",
    signatureBytes,
  );
  if (!valid || !isBaseClaims(decoded)) throw invalidTicket();
  if (
    decoded.aud !== config.audience ||
    decoded.purpose !== purpose ||
    decoded.method !== "POST" ||
    decoded.path !== `/api/internal/generation/${purpose}` ||
    nowSeconds + CLOCK_SKEW_SECONDS < decoded.nbf ||
    nowSeconds > decoded.exp
  ) {
    throw invalidTicket();
  }
  return decoded;
}

async function ticketMatchesFence(
  claims: BaseTicketClaims,
  fence: QueueFence,
): Promise<boolean> {
  return (
    claims.itemId === fence.itemId &&
    claims.leaseGeneration === fence.leaseGeneration &&
    claims.leaseTokenHash === (await sha256Hex(fence.leaseToken))
  );
}

function isBaseClaims(value: unknown): value is BaseTicketClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.aud === "string" &&
    (record.purpose === "input" || record.purpose === "output") &&
    record.method === "POST" &&
    typeof record.path === "string" &&
    validIdentifier(record.itemId) &&
    validIdentifier(record.attemptId) &&
    typeof record.leaseTokenHash === "string" &&
    SHA256_PATTERN.test(record.leaseTokenHash) &&
    Number.isSafeInteger(record.leaseGeneration) &&
    (record.leaseGeneration as number) >= 1 &&
    Number.isSafeInteger(record.nbf) &&
    Number.isSafeInteger(record.exp) &&
    validIdentifier(record.jti)
  );
}

function isInputClaims(value: unknown): value is InputTicketClaims {
  if (!isBaseClaims(value) || value.purpose !== "input") return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    validIdentifier(record.assetId) &&
    typeof record.role === "string" &&
    record.role.length > 0 &&
    record.role.length <= 64 &&
    Number.isSafeInteger(record.index) &&
    (record.index as number) >= 0 &&
    typeof record.mimeType === "string" &&
    Number.isSafeInteger(record.byteSize) &&
    (record.byteSize as number) > 0 &&
    typeof record.sha256 === "string" &&
    SHA256_PATTERN.test(record.sha256)
  );
}

function isOutputClaims(value: unknown): value is OutputTicketClaims {
  if (!isBaseClaims(value) || value.purpose !== "output") return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    validIdentifier(record.commitId) &&
    typeof record.mimeType === "string" &&
    Number.isSafeInteger(record.byteSize) &&
    (record.byteSize as number) > 0 &&
    typeof record.sha256 === "string" &&
    SHA256_PATTERN.test(record.sha256)
  );
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(
  secret: string,
  value: string,
  operation: "sign",
): Promise<Uint8Array>;
async function hmac(
  secret: string,
  value: string,
  operation: "verify",
  signature: Uint8Array,
): Promise<boolean>;
async function hmac(
  secret: string,
  value: string,
  operation: "sign" | "verify",
  signature?: Uint8Array,
): Promise<Uint8Array | boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [operation],
  );
  if (operation === "sign") {
    return new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    );
  }
  if (!signature) return false;
  const stable = new Uint8Array(signature.byteLength);
  stable.set(signature);
  return crypto.subtle.verify(
    "HMAC",
    key,
    stable.buffer,
    new TextEncoder().encode(value),
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidTicket();
  const remainder = value.length % 4;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    (remainder === 0 ? "" : "=".repeat(4 - remainder));
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_TICKET_MISCONFIGURED",
      `内部任务票据配置缺少 ${key}。`,
    );
  }
  return value.trim();
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
    throw invalidConfiguration();
  }
  return Number(value);
}

function invalidConfiguration(): ApiError {
  return new ApiError(
    503,
    "INTERNAL_QUEUE_TICKET_MISCONFIGURED",
    "内部任务票据配置无效。",
  );
}

function invalidTicket(): ApiError {
  return new ApiError(401, "INTERNAL_TICKET_INVALID", "内部任务票据无效或已过期。");
}
