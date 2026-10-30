import { request as httpRequest, type IncomingMessage } from "node:http";
import { lstat } from "node:fs/promises";
import { overseasImageModelValues } from "@/lib/domain/image-models";
import { OVERSEAS_SOCKET_ROOT, readRequestBody } from "./overseas-fetch";

export const SUB2API_SOCKET_PATH = `${OVERSEAS_SOCKET_ROOT}/sub2api.sock`;
const PROVIDER_ID_HEADER = "x-zaoshi-provider-request-id";

/** HTTP travels only inside the pinned SSH tunnel; official TLS runs on AWS. */
export function createSub2ApiTransport(options: { requestTimeoutMs?: number; privateTestExpiresAt?: number; publicGenerationEnabled?: boolean } = {}, dependencies: { request?: typeof httpRequest; lstat?: typeof lstat; effectiveUid?: number } = {}) {
  const request = dependencies.request ?? httpRequest;
  const inspect = dependencies.lstat ?? lstat;
  const uid = dependencies.effectiveUid ?? process.geteuid?.();
  const timeoutMs = options.requestTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("INVALID_OVERSEAS_TIMEOUT");
  if (options.publicGenerationEnabled && options.privateTestExpiresAt !== undefined) throw new Error("MIXED_GENERATION_MODE");
  const assertActive = () => { if (options.publicGenerationEnabled) return; if (!Number.isSafeInteger(options.privateTestExpiresAt) || Date.now() >= options.privateTestExpiresAt! * 1000) throw new Error("OVERSEAS_PRIVATE_TEST_NOT_CONFIGURED"); };
  const assertSocket = async () => {
    for (const path of ["/var", "/var/lib", "/var/lib/zaoshi", OVERSEAS_SOCKET_ROOT]) {
      const stat = await inspect(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (path === OVERSEAS_SOCKET_ROOT && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700))) throw new Error("OVERSEAS_SOCKET_UNSAFE");
    }
    const stat = await inspect(SUB2API_SOCKET_PATH);
    if (!Number.isSafeInteger(uid) || !stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw new Error("OVERSEAS_SOCKET_UNSAFE");
  };
  const wire = async (method: "GET" | "POST", path: string, headers: Headers, body: Buffer | undefined, signal: AbortSignal, limit: number) => {
    assertActive();
    signal.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      let response: IncomingMessage | undefined;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectDeadline);
        signal.removeEventListener("abort", abort);
        const id = response?.headers[PROVIDER_ID_HEADER];
        if (typeof id === "string" && id.length <= 200) Object.assign(error, { providerRequestId: id });
        response?.destroy(); outgoing.destroy(); reject(error);
      };
      const abort = () => fail(new DOMException("Aborted", "AbortError"));
      const outgoing = request({ hostname: "127.0.0.1", port: 8080, socketPath: SUB2API_SOCKET_PATH, method, path, agent: false, maxHeaderSize: 16 * 1024, headers: Object.fromEntries(headers), signal }, (incoming) => {
        response = incoming;
        clearTimeout(connectDeadline);
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) { fail(new Error("OVERSEAS_REDIRECT_FORBIDDEN")); return; }
        const maxBytes = status >= 200 && status < 300 ? limit : 64 * 1024;
        const declared = incoming.headers["content-length"];
        if (declared !== undefined && (!/^\d+$/u.test(String(declared)) || Number(declared) > maxBytes)) { fail(new Error("OVERSEAS_RESPONSE_TOO_LARGE")); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > maxBytes) fail(new Error("OVERSEAS_RESPONSE_TOO_LARGE")); else chunks.push(chunk); });
        incoming.once("aborted", () => fail(new Error("OVERSEAS_RESPONSE_INTERRUPTED")));
        incoming.once("error", fail);
        incoming.once("end", () => {
          if (settled) return;
          const exposed = new Headers();
          for (const name of ["content-type", "content-length", PROVIDER_ID_HEADER]) {
            const value = incoming.headers[name];
            if (typeof value === "string") exposed.set(name, value);
          }
          try {
            const result = new Response(status === 204 || status === 205 ? null : Buffer.concat(chunks), { status, headers: exposed });
            settled = true;
            signal.removeEventListener("abort", abort);
            resolve(result);
          } catch { fail(new Error("OVERSEAS_RESPONSE_INVALID")); }
        });
      });
      const connectDeadline = setTimeout(() => fail(new DOMException("OVERSEAS_CONNECT_TIMEOUT", "TimeoutError")), Math.min(15_000, timeoutMs));
      outgoing.once("socket", (socket) => socket.once("connect", () => clearTimeout(connectDeadline)));
      outgoing.once("error", fail);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      outgoing.end(body);
    });
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const openai = url.hostname === "api.openai.com" && ["/v1/images/generations", "/v1/images/edits"].includes(url.pathname);
    const google = url.hostname === "generativelanguage.googleapis.com" && overseasImageModelValues.some((model) => model.startsWith("gemini-") && url.pathname === `/v1beta/models/${model}:generateContent`);
    if ((!openai && !google) || url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash) throw new Error("OVERSEAS_URL_FORBIDDEN");
    const outgoing = new Request(input, init);
    if (outgoing.method !== "POST") throw new Error("OVERSEAS_METHOD_FORBIDDEN");
    const allowed = ["content-type", "x-request-id", openai ? "authorization" : "x-goog-api-key"];
    for (const name of outgoing.headers.keys()) if (!allowed.includes(name)) throw new Error("OVERSEAS_HEADER_FORBIDDEN");
    const auth = outgoing.headers.get(openai ? "authorization" : "x-goog-api-key");
    if (!auth || (openai && !/^Bearer [^\r\n]+$/u.test(auth))) throw new Error("OVERSEAS_AUTH_REQUIRED");
    if (!/^attempt_[A-Za-z0-9_-]{1,56}$/u.test(outgoing.headers.get("x-request-id") ?? "")) throw new Error("OVERSEAS_ATTEMPT_ID_REQUIRED");
    const signal = AbortSignal.any([outgoing.signal, AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    assertActive();
    await assertSocket();
    const body = await readRequestBody(outgoing, openai ? 32 * 1024 * 1024 : 20 * 1024 * 1024, signal);
    if (openai) {
      const fields = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(body.toString("utf8"));
      if (!overseasImageModelValues.some((model) => model.startsWith("gpt-") && fields.model === model) || String(fields.n) !== "1") throw new Error("OVERSEAS_MODEL_FORBIDDEN");
    }
    return wire("POST", url.pathname, outgoing.headers, body, signal, 12 * 1024 * 1024);
  };
  return {
    fetch,
    async assertReady(provider: "openai" | "google") {
      if (provider !== "openai" && provider !== "google") throw new Error("OVERSEAS_PROVIDER_FORBIDDEN");
      assertActive();
      await assertSocket();
      const result = await wire("GET", "/health", new Headers(), undefined, AbortSignal.timeout(Math.min(15_000, timeoutMs)), 64 * 1024);
      if (result.status !== 200) throw new Error("OVERSEAS_GATEWAY_UNAVAILABLE");
    },
  };
}
