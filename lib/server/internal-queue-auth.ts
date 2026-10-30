import { ApiError, requireJsonObject } from "./api";
import {
  isAllowedInternalControlPlaneRequest,
  resolveInternalControlPlaneTransport,
  type InternalControlPlaneTransport,
} from "@/lib/domain/internal-control-plane";

const MAX_CONTROL_BODY_BYTES = 16 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 90;
const NONCE_RETENTION_SECONDS = MAX_CLOCK_SKEW_SECONDS * 2;
const MAX_PREVIOUS_KEY_OVERLAP_SECONDS = 7 * 24 * 60 * 60;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/u;
const AUDIENCE_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const internalQueueHeaders = {
  keyId: "x-zaoshi-key-id",
  timestamp: "x-zaoshi-timestamp",
  nonce: "x-zaoshi-nonce",
  contentSha256: "x-zaoshi-content-sha256",
  signature: "x-zaoshi-signature",
} as const;

export type InternalQueueAuthConfig =
  | { enabled: false }
  | {
      enabled: true;
      audience: string;
      transport: InternalControlPlaneTransport;
      keys: ReadonlyMap<
        string,
        { secret: string; expiresAt: number | null }
      >;
    };

export type InternalQueueSigningInput = {
  keyId: string;
  secret: string;
  audience: string;
  method: "POST";
  pathname: string;
  body: Uint8Array;
  timestamp: number;
  nonce: string;
  contentType?: string;
};

export function resolveInternalQueueAuthConfig(
  environment: Record<string, unknown>,
  nowSeconds = Math.floor(Date.now() / 1000),
): InternalQueueAuthConfig {
  if (environment.GENERATION_INTERNAL_API_ENABLED !== "1") {
    return { enabled: false };
  }

  const currentKeyId = requiredEnvironmentString(
    environment.GENERATION_INTERNAL_CURRENT_KEY_ID,
    "GENERATION_INTERNAL_CURRENT_KEY_ID",
  );
  const currentSecret = requiredEnvironmentString(
    environment.GENERATION_INTERNAL_CURRENT_SECRET,
    "GENERATION_INTERNAL_CURRENT_SECRET",
  );
  validateKey(currentKeyId, currentSecret);
  const audience = requiredEnvironmentString(
    environment.GENERATION_INTERNAL_AUDIENCE,
    "GENERATION_INTERNAL_AUDIENCE",
  );
  validateAudience(audience);
  let transport: InternalControlPlaneTransport;
  try {
    transport = resolveInternalControlPlaneTransport(
      environment.GENERATION_INTERNAL_TRANSPORT,
    );
  } catch {
    throw invalidConfiguration();
  }
  if (
    transport === "private-docker" &&
    environment.ZAOSHI_RUNTIME !== "node"
  ) {
    throw invalidConfiguration();
  }

  const previousKeyId = optionalEnvironmentString(
    environment.GENERATION_INTERNAL_PREVIOUS_KEY_ID,
  );
  const previousSecret = optionalEnvironmentString(
    environment.GENERATION_INTERNAL_PREVIOUS_SECRET,
  );
  const previousExpiresAtText = optionalEnvironmentString(
    environment.GENERATION_INTERNAL_PREVIOUS_EXPIRES_AT,
  );
  if (
    new Set([
      Boolean(previousKeyId),
      Boolean(previousSecret),
      Boolean(previousExpiresAtText),
    ]).size !== 1
  ) {
    throw invalidConfiguration();
  }

  const keys = new Map<
    string,
    { secret: string; expiresAt: number | null }
  >([
    [currentKeyId, { secret: currentSecret, expiresAt: null }],
  ]);
  if (previousKeyId && previousSecret && previousExpiresAtText) {
    validateKey(previousKeyId, previousSecret);
    if (previousKeyId === currentKeyId) throw invalidConfiguration();
    const previousExpiresAt = parsePreviousExpiry(
      previousExpiresAtText,
      nowSeconds,
    );
    keys.set(previousKeyId, {
      secret: previousSecret,
      expiresAt: previousExpiresAt,
    });
  }
  return { enabled: true, audience, keys, transport };
}

export async function readAuthenticatedInternalQueueJson(
  request: Request,
  d1: D1Database,
  config: InternalQueueAuthConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown>> {
  const body = await readAuthenticatedInternalQueueBody(
    request,
    d1,
    config,
    {
      maxBytes: MAX_CONTROL_BODY_BYTES,
      contentTypes: ["application/json"],
      emptyErrorCode: "INVALID_JSON",
    },
    nowSeconds,
  );
  try {
    return requireJsonObject(JSON.parse(new TextDecoder().decode(body)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_JSON", "请求正文必须是 JSON 对象。");
  }
}

export async function readAuthenticatedInternalQueueBody(
  request: Request,
  d1: D1Database,
  config: InternalQueueAuthConfig,
  options: {
    maxBytes: number;
    contentTypes: readonly string[];
    emptyErrorCode?: string;
  },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Uint8Array> {
  if (!config.enabled) {
    throw new ApiError(404, "NOT_FOUND", "没有找到这个接口。");
  }
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 16 * 1024 * 1024 ||
    options.contentTypes.length < 1
  ) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_AUTH_MISCONFIGURED",
      "内部请求认证配置无效。",
    );
  }
  assertRequestEnvelope(request, options.contentTypes, config.transport);
  // Reject unauthenticated callers before buffering a potentially large
  // binary body. The signed declared hash is verified again against the
  // bytes after the bounded read.
  const envelope = await verifyInternalQueueEnvelope(request, config, nowSeconds);
  const body = await readBoundedBody(
    request,
    options.maxBytes,
    options.emptyErrorCode ?? "INVALID_INTERNAL_BODY",
  );
  const actualHash = await sha256Hex(body);
  if (envelope.declaredHash !== actualHash) {
    throw authenticationFailed();
  }
  await consumeInternalQueueNonce(
    d1,
    config.audience,
    envelope.keyId,
    envelope.nonce,
    nowSeconds,
  );
  return body;
}

export async function createSignedInternalQueueHeaders(
  input: InternalQueueSigningInput,
): Promise<Headers> {
  validateKey(input.keyId, input.secret);
  validateAudience(input.audience);
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 1) {
    throw new Error("INVALID_INTERNAL_QUEUE_TIMESTAMP");
  }
  if (!NONCE_PATTERN.test(input.nonce)) {
    throw new Error("INVALID_INTERNAL_QUEUE_NONCE");
  }
  if (!isInternalPath(input.pathname)) {
    throw new Error("INVALID_INTERNAL_QUEUE_PATH");
  }
  const contentSha256 = await sha256Hex(input.body);
  const signature = await hmacBase64Url(
    input.secret,
    canonicalRequest({
      audience: input.audience,
      keyId: input.keyId,
      timestamp: input.timestamp,
      nonce: input.nonce,
      method: input.method,
      pathname: input.pathname,
      contentSha256,
    }),
  );
  return new Headers({
    "Content-Type": input.contentType ?? "application/json",
    [internalQueueHeaders.keyId]: input.keyId,
    [internalQueueHeaders.timestamp]: String(input.timestamp),
    [internalQueueHeaders.nonce]: input.nonce,
    [internalQueueHeaders.contentSha256]: contentSha256,
    [internalQueueHeaders.signature]: signature,
  });
}

async function verifyInternalQueueEnvelope(
  request: Request,
  config: Extract<InternalQueueAuthConfig, { enabled: true }>,
  nowSeconds: number,
): Promise<{ keyId: string; nonce: string; declaredHash: string }> {
  const keyId = request.headers.get(internalQueueHeaders.keyId) ?? "";
  const timestampText = request.headers.get(internalQueueHeaders.timestamp) ?? "";
  const nonce = request.headers.get(internalQueueHeaders.nonce) ?? "";
  const declaredHash = request.headers.get(internalQueueHeaders.contentSha256) ?? "";
  const signature = request.headers.get(internalQueueHeaders.signature) ?? "";

  if (
    !KEY_ID_PATTERN.test(keyId) ||
    !/^\d{10}$/u.test(timestampText) ||
    !NONCE_PATTERN.test(nonce) ||
    !SHA256_HEX_PATTERN.test(declaredHash) ||
    !SIGNATURE_PATTERN.test(signature)
  ) {
    throw authenticationFailed();
  }
  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS
  ) {
    throw authenticationFailed();
  }
  const keyConfig = config.keys.get(keyId);
  if (
    !keyConfig ||
    (keyConfig.expiresAt !== null && nowSeconds > keyConfig.expiresAt)
  ) {
    throw authenticationFailed();
  }

  const signatureValid = await verifyHmacBase64Url(
    keyConfig.secret,
    canonicalRequest({
      audience: config.audience,
      keyId,
      timestamp,
      nonce,
      method: "POST",
      pathname: new URL(request.url).pathname,
      contentSha256: declaredHash,
    }),
    signature,
  );
  if (!signatureValid) {
    throw authenticationFailed();
  }

  return { keyId, nonce, declaredHash };
}

async function consumeInternalQueueNonce(
  d1: D1Database,
  audience: string,
  keyId: string,
  nonce: string,
  nowSeconds: number,
): Promise<void> {
  const nonceHash = await sha256Hex(
    new TextEncoder().encode(`${audience}\n${keyId}\n${nonce}`),
  );
  try {
    const [insertResult] = await d1.batch([
      d1
        .prepare(
          `INSERT OR IGNORE INTO generation_internal_nonces
            (nonce_hash, key_id, expires_at)
           VALUES (?, ?, ?)`,
        )
        .bind(nonceHash, keyId, nowSeconds + NONCE_RETENTION_SECONDS),
      d1
        .prepare(
          "DELETE FROM generation_internal_nonces WHERE expires_at < ?",
        )
        .bind(nowSeconds),
    ]);
    if (resultChanges(insertResult) !== 1) {
      throw new ApiError(
        409,
        "INTERNAL_REQUEST_REPLAY",
        "这个内部请求已经处理过。",
      );
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      "INTERNAL_AUTH_STORAGE_UNAVAILABLE",
      "内部请求认证存储暂时不可用。",
    );
  }
}

function assertRequestEnvelope(
  request: Request,
  allowedContentTypes: readonly string[],
  transport: InternalControlPlaneTransport,
): void {
  const url = new URL(request.url);
  const contentType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    request.method !== "POST" ||
    !isAllowedInternalControlPlaneRequest(url, transport) ||
    url.search !== "" ||
    !isInternalPath(url.pathname) ||
    !allowedContentTypes.includes(contentType)
  ) {
    throw authenticationFailed();
  }
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
  emptyErrorCode: string,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (
    declared !== null &&
    (!Number.isSafeInteger(declared) || declared < 0)
  ) {
    throw new ApiError(400, "INVALID_CONTENT_LENGTH", "内部请求长度无效。");
  }
  if (declared !== null && declared > maxBytes) {
    throw new ApiError(413, "BODY_TOO_LARGE", "内部请求正文过大。");
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new ApiError(400, emptyErrorCode, "请求正文不能为空。");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      throw new ApiError(413, "BODY_TOO_LARGE", "内部请求正文过大。");
    }
    chunks.push(part.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (result.byteLength === 0) {
    throw new ApiError(400, emptyErrorCode, "请求正文不能为空。");
  }
  if (declared !== null && declared !== result.byteLength) {
    throw new ApiError(400, "INVALID_CONTENT_LENGTH", "内部请求长度无效。");
  }
  return result;
}

function canonicalRequest(input: {
  audience: string;
  keyId: string;
  timestamp: number;
  nonce: string;
  method: "POST";
  pathname: string;
  contentSha256: string;
}): string {
  return [
    "v1",
    input.audience,
    input.keyId,
    String(input.timestamp),
    input.nonce,
    input.method,
    input.pathname,
    input.contentSha256,
  ].join("\n");
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return bytesToBase64Url(signature);
}

async function verifyHmacBase64Url(
  secret: string,
  value: string,
  signature: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const decoded = base64UrlToBytes(signature);
  const stableSignature = new Uint8Array(decoded.byteLength);
  stableSignature.set(decoded);
  return crypto.subtle.verify(
    "HMAC",
    key,
    stableSignature.buffer,
    new TextEncoder().encode(value),
  );
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const stable = new Uint8Array(value.byteLength);
  stable.set(value);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", stable.buffer),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validateKey(keyId: string, secret: string): void {
  const secretBytes = new TextEncoder().encode(secret).byteLength;
  if (
    !KEY_ID_PATTERN.test(keyId) ||
    secretBytes < 32 ||
    secretBytes > 256
  ) {
    throw invalidConfiguration();
  }
}

function validateAudience(audience: string): void {
  if (!AUDIENCE_PATTERN.test(audience)) throw invalidConfiguration();
}

function parsePreviousExpiry(value: string, nowSeconds: number): number {
  if (!/^\d{10}$/u.test(value)) throw invalidConfiguration();
  const expiresAt = Number(value);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 1 ||
    expiresAt > nowSeconds + MAX_PREVIOUS_KEY_OVERLAP_SECONDS
  ) {
    throw invalidConfiguration();
  }
  return expiresAt;
}

function requiredEnvironmentString(value: unknown, key: string): string {
  const normalized = optionalEnvironmentString(value);
  if (!normalized) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_AUTH_MISCONFIGURED",
      `内部队列认证配置缺少 ${key}。`,
    );
  }
  return normalized;
}

function optionalEnvironmentString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isInternalPath(pathname: string): boolean {
  return /^\/api\/internal\/generation\/[a-z-]+$/u.test(pathname);
}

function authenticationFailed(): ApiError {
  return new ApiError(401, "INTERNAL_AUTH_FAILED", "内部请求认证失败。");
}

function invalidConfiguration(): ApiError {
  return new ApiError(
    503,
    "INTERNAL_QUEUE_AUTH_MISCONFIGURED",
    "内部队列认证配置无效。",
  );
}

function resultChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}
