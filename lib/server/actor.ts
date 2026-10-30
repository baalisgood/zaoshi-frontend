import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api";

const SESSION_COOKIE = "designer_session";
const SESSION_PATTERN = /^[A-Za-z0-9_-]{32,80}$/;

export type RequestActor = {
  ownerId: string;
  identityNamespace?: string;
  setCookie: string | null;
  trusted?: boolean;
  user: {
    authenticated: boolean;
    displayName: string;
    email?: string;
    verifiedIdentity?: "email" | "wechat";
    role?: "USER" | "ADMIN";
  };
};

export function getRequestActor(
  request: Request,
  trustPlatformIdentityHeaders = false,
): RequestActor {
  const authenticatedId = trustPlatformIdentityHeaders
    ? request.headers.get("oai-authenticated-user-id")
    : null;
  if (authenticatedId) {
    const email = safeDisplayValue(
      request.headers.get("oai-authenticated-user-email"),
      254,
    );
    const fullName = readPlatformFullName(request);
    return {
      ownerId: `chatgpt:${hashIdentifier(authenticatedId)}`,
      setCookie: null,
      trusted: true,
      user: {
        authenticated: true,
        displayName: fullName ?? email ?? "已登录用户",
        ...(email ? { email } : {}),
      },
    };
  }

  const existingSession = readCookie(
    request.headers.get("cookie"),
    SESSION_COOKIE,
  );
  if (existingSession && SESSION_PATTERN.test(existingSession)) {
    return {
      ownerId: `session:${hashIdentifier(existingSession)}`,
      setCookie: null,
      user: { authenticated: false, displayName: "访客" },
    };
  }

  const session = randomToken();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    ownerId: `session:${hashIdentifier(session)}`,
    setCookie: `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`,
    user: { authenticated: false, displayName: "访客" },
  };
}

export function attachActorCookie(
  response: Response,
  actor: RequestActor,
): Response {
  if (!actor.setCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", actor.setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const segment of header.split(";")) {
    const [key, ...rest] = segment.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function hashIdentifier(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertDraftScope(value: unknown, actor: RequestActor): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new ApiError(409, "DRAFT_SCOPE_MISMATCH", "浏览器草稿不属于当前登录账号。");
  const actual = new TextEncoder().encode(value);
  const expected = new TextEncoder().encode(hashIdentifier(`draft:${actor.identityNamespace ?? actor.ownerId}`));
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) throw new ApiError(409, "DRAFT_SCOPE_MISMATCH", "浏览器草稿不属于当前登录账号。");
}

function readPlatformFullName(request: Request): string | null {
  if (
    request.headers.get("oai-authenticated-user-full-name-encoding") !==
    "percent-encoded-utf-8"
  ) {
    return null;
  }
  const encoded = request.headers.get("oai-authenticated-user-full-name");
  if (!encoded) return null;
  try {
    return safeDisplayValue(decodeURIComponent(encoded), 120);
  } catch {
    return null;
  }
}

export function safeDisplayValue(value: string | null, max: number): string | null {
  if (!value) return null;
  const normalized = Array.from(value.normalize("NFKC"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("")
    .trim()
    .slice(0, max);
  return normalized || null;
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
