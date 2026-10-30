import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { request as httpsRequest, createServer as createHttpsServer } from "node:https";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { createServer as createNetServer, connect, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lstat } from "node:fs/promises";
import { createOverseasTransport, OVERSEAS_SOCKET_ROOT } from "../../lib/consumer/overseas-fetch";

const url = "https://api.openai.com/v1/images/generations";
const init = { method: "POST", headers: { authorization: "Bearer test-only-key", "content-type": "application/json" }, body: "{}" };
const safeStat = (path: string) => ({ mode: path.endsWith(".sock") ? 0o600 : 0o700, uid: 10001, isSocket: () => path.endsWith(".sock"), isDirectory: () => !path.endsWith(".sock"), isSymbolicLink: () => false });
const inspect = (async (path: string) => safeStat(path)) as unknown as typeof lstat;

function mockTransport(scenario: { status?: number; chunks?: Buffer[]; headers?: Record<string, string>; phase?: "connect" | "headers" | "body"; onDispatch?: () => void } = {}) {
  let calls = 0;
  let destroyed = 0;
  const request = ((options: Record<string, unknown>, callback: (incoming: unknown) => void) => {
    calls++;
    scenario.onDispatch?.();
    assert.equal(options.hostname, "api.openai.com"); assert.equal(options.servername, "api.openai.com"); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false); assert.equal(options.socketPath, `${OVERSEAS_SOCKET_ROOT}/openai.sock`); assert.equal(options.ca, undefined);
    const outgoing = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    outgoing.destroy = () => { destroyed++; };
    outgoing.end = () => queueMicrotask(() => {
      if (scenario.phase === "connect") return;
      const socket = new EventEmitter(); outgoing.emit("socket", socket); socket.emit("secureConnect");
      if (scenario.phase === "headers") return;
      const incoming = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      incoming.statusCode = scenario.status ?? 200;
      incoming.headers = { "x-request-id": "actual-transport", "content-type": "application/json", ...scenario.headers };
      incoming.destroy = () => { destroyed++; };
      callback(incoming);
      for (const chunk of scenario.chunks ?? [Buffer.from("{}")]) incoming.emit("data", chunk);
      if (scenario.phase !== "body") incoming.emit("end");
    });
    return outgoing;
  }) as unknown as typeof httpsRequest;
  return { transport: createOverseasTransport({ requestTimeoutMs: 50, privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60 }, { request, lstat: inspect, effectiveUid: 10001 }), counts: () => ({ calls, destroyed }) };
}

test("fixed TLS transport rejects arbitrary URLs, headers and unsafe sockets before upstream", async () => {
  const { transport, counts } = mockTransport();
  for (const bad of ["http://api.openai.com/v1/images/generations", "https://evil.example/v1/images/generations", `${url}?key=bad`, `${url}#fragment`, "https://api.openai.com:444/v1/images/generations", "https://user@api.openai.com/v1/images/generations", "https://api.openai.com/v1/models"]) await assert.rejects(transport.fetch(bad, init));
  for (const header of ["Host", "Cookie", "Connection", "Proxy-Authorization"]) await assert.rejects(transport.fetch(url, { ...init, headers: { ...init.headers, [header]: "unsafe" } }));
  await assert.rejects(transport.fetch(url, { ...init, method: "GET", body: undefined }));
  assert.equal(counts().calls, 0);
  for (const unsafe of ["symlink", "mode", "owner", "regular-file"]) {
    const malformed = (async (path: string) => ({ ...safeStat(path), ...(path.endsWith(".sock") ? { isSymbolicLink: () => unsafe === "symlink", isSocket: () => unsafe !== "regular-file", mode: unsafe === "mode" ? 0o666 : 0o600, uid: unsafe === "owner" ? 0 : 10001 } : {}) })) as unknown as typeof lstat;
    await assert.rejects(createOverseasTransport({ privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60 }, { lstat: malformed, effectiveUid: 10001 }).assertReady("openai"), /OVERSEAS_SOCKET_UNSAFE/u);
  }
});

test("prepare probes TLS without HTTP and rejects failed, timed out or aborted handshakes", async () => {
  for (const phase of ["success", "error", "timeout", "abort"] as const) {
    let probes = 0;
    let destroyed = 0;
    let httpCalls = 0;
    const connect = ((options: ConnectionOptions) => {
      probes++;
      assert.equal(options.path, `${OVERSEAS_SOCKET_ROOT}/openai.sock`);
      assert.equal(options.servername, "api.openai.com"); assert.equal(options.rejectUnauthorized, true); assert.equal(options.ca, undefined);
      const socket = new EventEmitter() as EventEmitter & { destroy(): void };
      socket.destroy = () => { destroyed++; };
      queueMicrotask(() => { if (phase === "success") socket.emit("secureConnect"); else if (phase === "error") socket.emit("error", new Error("unreachable")); });
      return socket;
    }) as unknown as typeof tlsConnect;
    const transport = createOverseasTransport({ requestTimeoutMs: 20, privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60 }, { connect, lstat: inspect, effectiveUid: 10001, request: (() => { httpCalls++; throw new Error("HTTP forbidden in prepare"); }) as typeof httpsRequest });
    const ready = transport.assertReady("openai", phase === "abort" ? AbortSignal.timeout(5) : undefined);
    if (phase === "success") await ready; else await assert.rejects(ready);
    assert.equal(probes, 1); assert.equal(destroyed, 1); assert.equal(httpCalls, 0);
  }
});

test("expiry during socket inspection prevents POST, while an already dispatched POST can finish", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const expiresAt = Math.floor(clock / 1000) + 60;
  let calls = 0;
  const transport = createOverseasTransport({ privateTestExpiresAt: expiresAt }, {
    effectiveUid: 10001,
    lstat: (async (path: string) => { await Promise.resolve(); clock = expiresAt * 1000; return safeStat(path); }) as unknown as typeof lstat,
    request: (() => { calls++; throw new Error("post-expiry upstream forbidden"); }) as typeof httpsRequest,
  });
  await assert.rejects(transport.fetch(url, init), /OVERSEAS_PRIVATE_TEST_NOT_CONFIGURED/u);
  assert.equal(calls, 0);
  const inFlight = mockTransport({ onDispatch() { clock += 120_000; } });
  assert.equal((await inFlight.transport.fetch(url, init)).status, 200);
  assert.equal(inFlight.counts().calls, 1);
});

test("bounded transport handles 204/205, redirects, streaming overflow and aborts with actual IDs", async () => {
  for (const status of [200, 204, 205]) {
    const { transport, counts } = mockTransport({ status, chunks: status === 200 ? [Buffer.from("{}")] : [] });
    const result = await transport.fetch(url, init); assert.equal(result.status, status); assert.equal(result.headers.get("x-request-id"), "actual-transport"); assert.equal(counts().calls, 1);
  }
  for (const scenario of [{ status: 302 }, { headers: { "content-length": String(12 * 1024 * 1024 + 1) } }, { chunks: [Buffer.alloc(12 * 1024 * 1024), Buffer.from("x")] }, { status: 400, chunks: [Buffer.alloc(64 * 1024 + 1)] }]) {
    const { transport, counts } = mockTransport(scenario);
    await assert.rejects(transport.fetch(url, init), (error: unknown) => Boolean(error && typeof error === "object" && "providerRequestId" in error && error.providerRequestId === "actual-transport"));
    assert.equal(counts().calls, 1); assert.ok(counts().destroyed > 0);
  }
  for (const phase of ["connect", "headers", "body"] as const) {
    const { transport, counts } = mockTransport({ phase });
    await assert.rejects(transport.fetch(url, { ...init, signal: AbortSignal.timeout(10) }));
    assert.equal(counts().calls, 1); assert.ok(counts().destroyed > 0);
  }
  const { transport } = mockTransport({ phase: "body" });
  await assert.rejects(transport.fetch(url, init));
});

test("HTTPS over actual Unix forwarding keeps TLS encrypted and rejects untrusted CA and wrong hostname", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zaoshi-overseas-transport-"));
  const connections = new Set<Socket>();
  let upstream: ReturnType<typeof createHttpsServer> | undefined;
  let relay: ReturnType<typeof createNetServer> | undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=api.openai.com", "-addext", "subjectAltName=DNS:api.openai.com"], { stdio: "ignore" });
    const ca = readFileSync(join(dir, "cert.pem"));
    let accepted = 0;
    let firstRelayByte = 0;
    upstream = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert: ca }, (request, response) => {
      accepted++; assert.equal(request.headers.host, "api.openai.com"); assert.equal((request.socket as Socket & { servername: string }).servername, "api.openai.com");
      request.resume(); response.writeHead(200, { "content-type": "application/json", "x-request-id": "actual-local-tls" }); response.end("{}");
    });
    upstream.on("tlsClientError", () => undefined);
    await new Promise<void>((resolve, reject) => upstream!.listen(0, "127.0.0.1", resolve).once("error", reject));
    relay = createNetServer((client) => {
      const socket = connect((upstream!.address() as { port: number }).port, "127.0.0.1");
      for (const value of [client, socket]) { connections.add(value); value.on("close", () => connections.delete(value)); }
      client.once("data", (data) => { firstRelayByte = data[0]; });
      client.on("error", () => socket.destroy()); socket.on("error", () => client.destroy()); client.pipe(socket).pipe(client);
    });
    const socketPath = join(dir, "relay.sock");
    await new Promise<void>((resolve, reject) => relay!.listen(socketPath, resolve).once("error", reject));
    const transport = (trusted: boolean, wrongHost = false, missingSocket = false) => createOverseasTransport({ requestTimeoutMs: 2000, privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60 }, { lstat: inspect, effectiveUid: 10001, connect: ((options: ConnectionOptions) => {
      assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, "api.openai.com"); assert.equal(options.ca, undefined);
      return tlsConnect({ ...options, path: missingSocket ? join(dir, "absent.sock") : socketPath, ...(trusted ? { ca } : {}), ...(wrongHost ? { servername: "wrong.example" } : {}) });
    }) as typeof tlsConnect, request: ((options: Record<string, unknown>, callback: (incoming: IncomingMessage) => void) => {
      assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, "api.openai.com"); assert.equal(options.ca, undefined);
      return httpsRequest({ ...options, socketPath, ...(trusted ? { ca } : {}), ...(wrongHost ? { servername: "wrong.example" } : {}) }, callback);
    }) as unknown as typeof httpsRequest });
    await assert.rejects(transport(false).fetch(url, init), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    await assert.rejects(transport(true, true).fetch(url, init), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    await assert.rejects(transport(false).assertReady("openai"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    await assert.rejects(transport(true, true).assertReady("openai"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    await assert.rejects(transport(true, false, true).assertReady("openai"), { code: "ENOENT" });
    const ready = transport(true);
    await ready.assertReady("openai");
    assert.equal(accepted, 0);
    assert.equal((await ready.fetch(url, init)).headers.get("x-request-id"), "actual-local-tls");
    assert.equal(firstRelayByte, 22); assert.equal(accepted, 1);
  } finally {
    for (const socket of connections) socket.destroy();
    await Promise.all([relay, upstream].filter(Boolean).map((server) => new Promise<void>((resolve) => server!.close(() => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  }
});
