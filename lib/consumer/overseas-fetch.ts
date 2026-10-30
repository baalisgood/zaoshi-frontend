import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { lstat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";

export const OVERSEAS_SOCKET_ROOT = "/var/lib/zaoshi/overseas-sockets";
const targets = {
  openai: { hostname: "api.openai.com", paths: ["/v1/images/generations", "/v1/images/edits"], socketPath: `${OVERSEAS_SOCKET_ROOT}/openai.sock`, maxRequestBytes: 32 * 1024 * 1024 },
  google: { hostname: "generativelanguage.googleapis.com", paths: ["/v1beta/interactions"], socketPath: `${OVERSEAS_SOCKET_ROOT}/google.sock`, maxRequestBytes: 20 * 1024 * 1024 },
} as const;
type OverseasProvider = keyof typeof targets;

/** Strict POST-only fetch subset. TLS terminates at the fixed official hostname. */
export function createOverseasTransport(options: { requestTimeoutMs?: number; privateTestExpiresAt?: number } = {}, dependencies: { request?: typeof httpsRequest; connect?: typeof tlsConnect; lstat?: typeof lstat; effectiveUid?: number } = {}) {
  const request = dependencies.request ?? httpsRequest;
  const connect = dependencies.connect ?? tlsConnect;
  const inspect = dependencies.lstat ?? lstat;
  const uid = dependencies.effectiveUid ?? process.geteuid?.();
  const timeoutMs = options.requestTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("INVALID_OVERSEAS_TIMEOUT");
  if (options.privateTestExpiresAt !== undefined && (!Number.isSafeInteger(options.privateTestExpiresAt) || options.privateTestExpiresAt <= 0)) throw new Error("INVALID_PRIVATE_TEST_EXPIRY");
  const assertActive = () => { if (options.privateTestExpiresAt === undefined || Date.now() >= options.privateTestExpiresAt * 1000) throw new Error("OVERSEAS_PRIVATE_TEST_NOT_CONFIGURED"); };
  const assertSocket = async (provider: OverseasProvider) => {
    for (const path of ["/var", "/var/lib", "/var/lib/zaoshi", OVERSEAS_SOCKET_ROOT]) {
      const stat = await inspect(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (path === OVERSEAS_SOCKET_ROOT && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700))) throw new Error("OVERSEAS_SOCKET_UNSAFE");
    }
    const stat = await inspect(targets[provider].socketPath);
    if (!Number.isSafeInteger(uid) || !stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw new Error("OVERSEAS_SOCKET_UNSAFE");
  };
  const assertReady = async (provider: OverseasProvider, signal?: AbortSignal) => {
    assertActive();
    signal?.throwIfAborted();
    await assertSocket(provider);
    assertActive();
    signal?.throwIfAborted();
    const target = targets[provider];
    // An authenticated TLS handshake checks the SSH route without HTTP, credentials or paid work.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = connect({ path: target.socketPath, servername: target.hostname, rejectUnauthorized: true });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new DOMException("Aborted", "AbortError"));
      const deadline = setTimeout(() => finish(new DOMException("OVERSEAS_CONNECT_TIMEOUT", "TimeoutError")), Math.min(15_000, timeoutMs));
      socket.once("secureConnect", () => finish());
      socket.once("error", finish);
      socket.once("close", () => finish(new Error("OVERSEAS_SOCKET_UNAVAILABLE")));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    assertActive();
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const startedAt = Date.now();
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const provider = (Object.keys(targets) as OverseasProvider[]).find((key) => targets[key].hostname === url.hostname);
    if (!provider || url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash || !(targets[provider].paths as readonly string[]).includes(url.pathname)) throw new Error("OVERSEAS_URL_FORBIDDEN");
    const outgoing = new Request(input, init);
    if (outgoing.method !== "POST") throw new Error("OVERSEAS_METHOD_FORBIDDEN");
    const allowedHeaders = provider === "openai" ? ["authorization", "content-type"] : ["x-goog-api-key", "content-type"];
    for (const name of outgoing.headers.keys()) if (!allowedHeaders.includes(name)) throw new Error("OVERSEAS_HEADER_FORBIDDEN");
    const authentication = outgoing.headers.get(provider === "openai" ? "authorization" : "x-goog-api-key");
    if (!authentication || (provider === "openai" && !/^Bearer [^\r\n]+$/u.test(authentication))) throw new Error("OVERSEAS_AUTH_REQUIRED");
    const signal = AbortSignal.any([outgoing.signal, AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    await assertSocket(provider);
    const body = await readRequestBody(outgoing, targets[provider].maxRequestBytes, signal);
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new DOMException("Aborted", "AbortError");
    return new Promise<Response>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline); clearTimeout(connectDeadline);
        signal.removeEventListener("abort", abort);
        const actualId = response?.headers["x-request-id"] ?? response?.headers["x-goog-request-id"];
        if (typeof actualId === "string" && actualId.length <= 200) Object.assign(error, { providerRequestId: actualId });
        response?.destroy(); outgoingRequest.destroy();
        reject(error);
      };
      const abort = () => fail(new DOMException("Aborted", "AbortError"));
      const target = targets[provider];
      // lstat and body serialization can cross the deadline. Never start a POST after expiry.
      assertActive();
      const outgoingRequest = request({ hostname: target.hostname, servername: target.hostname, rejectUnauthorized: true, port: 443, socketPath: target.socketPath, method: "POST", path: url.pathname, agent: false, maxHeaderSize: 16 * 1024, headers: Object.fromEntries(outgoing.headers), signal }, (incoming) => {
        response = incoming;
        clearTimeout(connectDeadline);
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) { fail(new Error("OVERSEAS_REDIRECT_FORBIDDEN")); return; }
        const limit = status >= 200 && status < 300 ? 12 * 1024 * 1024 : 64 * 1024;
        const declared = incoming.headers["content-length"];
        if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > limit)) { fail(new Error("OVERSEAS_RESPONSE_TOO_LARGE")); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > limit) fail(new Error("OVERSEAS_RESPONSE_TOO_LARGE")); else chunks.push(chunk); });
        incoming.once("aborted", () => fail(new Error("OVERSEAS_RESPONSE_INTERRUPTED")));
        incoming.once("error", fail);
        incoming.once("end", () => {
          if (settled) return;
          let result: Response;
          try {
            const headers = new Headers();
            for (const name of ["content-type", "content-length", "x-request-id", "x-goog-request-id"]) { const value = incoming.headers[name]; if (typeof value === "string") headers.set(name, value); }
            result = new Response(status === 204 || status === 205 ? null : Buffer.concat(chunks), { status, headers });
          } catch { fail(new Error("OVERSEAS_RESPONSE_INVALID")); return; }
          settled = true;
          clearTimeout(deadline); clearTimeout(connectDeadline);
          signal.removeEventListener("abort", abort);
          resolve(result);
        });
      });
      const deadline = setTimeout(abort, remainingMs);
      const connectDeadline = setTimeout(() => fail(new DOMException("OVERSEAS_CONNECT_TIMEOUT", "TimeoutError")), Math.min(15_000, remainingMs));
      outgoingRequest.once("socket", (socket) => socket.once("secureConnect", () => clearTimeout(connectDeadline)));
      outgoingRequest.once("error", fail);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      outgoingRequest.end(body);
    });
  };
  return { fetch, assertReady };
}

export async function readRequestBody(request: Request, limit: number, signal: AbortSignal): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("OVERSEAS_BODY_REQUIRED");
  const abort = () => { void reader.cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("OVERSEAS_REQUEST_TOO_LARGE"); }
      chunks.push(value);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}
