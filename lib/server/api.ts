export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function readJsonBody(request: Request, maxBytes = 32 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new ApiError(413, "BODY_TOO_LARGE", "请求正文过大。");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "请求正文不能为空。");
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > maxBytes) throw new ApiError(413, "BODY_TOO_LARGE", "请求正文过大。"); chunks.push(part.value); }
  try { return JSON.parse(new TextDecoder().decode(new Uint8Array(chunks.reduce((all, chunk) => [...all, ...chunk], [] as number[])))); } catch { throw new ApiError(400, "INVALID_JSON", "无法读取 JSON 请求正文。"); }
}

export function jsonResponse(
  body: Record<string, unknown>,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }

  console.error("Unhandled API error", {
    requestId,
    errorName: error instanceof Error ? error.name : typeof error,
  });
  return jsonResponse(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用，请稍后再试。",
        requestId,
      },
    },
    { status: 500 },
  );
}

export function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_JSON", "请求正文必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_FIELD", `${field} 必须是字符串。`, {
      field,
    });
  }
  const normalized = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 200;
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `${field} 长度必须在 ${min} 到 ${max} 个字符之间。`,
      { field },
    );
  }
  return normalized;
}

export function optionalString(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, { max });
}

export function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 的值不受支持。`, {
      field,
      allowed,
    });
  }
  return value as T;
}
