import assert from "node:assert/strict";
import test from "node:test";
import { request, createServer, type ServerResponse, type RequestOptions, type IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { lstat } from "node:fs/promises";
import { createSub2ApiTransport, SUB2API_SOCKET_PATH } from "../../lib/consumer/sub2api-fetch";

const url = "https://api.openai.com/v1/images/generations";
const init = { method: "POST", headers: { authorization: "Bearer fake-gateway-key", "content-type": "application/json", "x-request-id": "attempt_test" }, body: '{"model":"gpt-image-2","n":1}' };
const inspect = (async (path: string) => ({ mode: path.endsWith(".sock") ? 0o600 : 0o700, uid: 10001, isSocket: () => path.endsWith(".sock"), isDirectory: () => !path.endsWith(".sock"), isSymbolicLink: () => false })) as unknown as typeof lstat;

test("fixed Unix relay performs real HTTP once; health carries no credentials and upstream ID has one source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zaoshi-sub2-wire-"));
  const socketPath = join(directory, "relay.sock");
  let posts = 0; let gets = 0;
  const server = createServer((req, res) => {
    assert.equal(req.httpVersion, "1.1");
    if (req.url === "/health") { gets++; assert.equal(req.headers.authorization, undefined); res.end("{}"); return; }
    posts++; assert.equal(req.headers["x-request-id"], "attempt_test"); assert.equal(req.headers.authorization, "Bearer fake-gateway-key");
    res.setHeader("x-request-id", "gateway-generated");
    res.setHeader("x-zaoshi-provider-request-id", "actual-upstream");
    res.end('{"id":"arbitrary-body"}');
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const routedRequest = ((options: RequestOptions, callback: (incoming: IncomingMessage) => void) => {
    assert.equal((options as { socketPath: string }).socketPath, SUB2API_SOCKET_PATH);
    assert.equal((options as { agent: boolean }).agent, false);
    return request({ ...options as object, socketPath }, callback);
  }) as typeof request;
  try {
    const transport = createSub2ApiTransport({ privateTestExpiresAt: Math.floor(Date.now() / 1000) + 60 }, { request: routedRequest, lstat: inspect, effectiveUid: 10001 });
    await transport.assertReady("openai");
    const result = await transport.fetch(url, init);
    assert.equal(result.headers.get("x-request-id"), null); assert.equal(result.headers.get("x-zaoshi-provider-request-id"), "actual-upstream");
    assert.equal(posts, 1); assert.equal(gets, 1);
    for (const bad of ["http://api.openai.com/v1/images/generations", "https://evil.example/v1/images/generations", `${url}?key=bad`, "https://api.openai.com/v1/models"]) await assert.rejects(transport.fetch(bad, init));
    for (const header of ["Host", "Cookie", "Connection", "X-Client-Request-ID"]) await assert.rejects(transport.fetch(url, { ...init, headers: { ...init.headers, [header]: "unsafe" } }));
    await assert.rejects(transport.fetch(url, { ...init, body: '{"model":"unexpected","n":1}' }));
    await assert.rejects(transport.fetch(url, { ...init, headers: { authorization: "Bearer fake-gateway-key", "content-type": "application/json" } }));
    assert.equal(posts, 1);
    assert.throws(() => createSub2ApiTransport({ publicGenerationEnabled: true, privateTestExpiresAt: Math.floor(Date.now()/1000)+60 }), /MIXED_GENERATION_MODE/u);
    const formal = createSub2ApiTransport({ publicGenerationEnabled: true }, { request: routedRequest, lstat: inspect, effectiveUid: 10001 });
    await formal.assertReady("openai");
    await formal.fetch(url, init);
    assert.equal(posts, 2);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test("real relay failure paths retain genuine ID without replay", async () => {
  for (const scenario of ["error", "redirect", "large", "truncated", "timeout", "no-id"] as const) {
    const directory = mkdtempSync(join(tmpdir(), "zaoshi-sub2-failure-")); const socketPath = join(directory, "relay.sock"); let posts = 0;
    const live = new Set<ServerResponse>();
    const server = createServer((req, res) => {
      posts++; live.add(res); res.once("close", () => live.delete(res));
      res.setHeader("x-request-id", "gateway-only"); if (scenario !== "no-id") res.setHeader("x-zaoshi-provider-request-id", "real-failure-id");
      if (scenario === "redirect") { res.writeHead(307, { location: url }); res.end(); }
      else if (scenario === "large") { res.setHeader("content-length", 13 * 1024 * 1024); res.end(); }
      else if (scenario === "truncated") { res.writeHead(200, { "content-length": 100 }); res.flushHeaders(); res.write("{}"); setImmediate(() => res.destroy()); }
      else if (scenario === "timeout") { res.writeHead(200); res.flushHeaders(); }
      else { res.writeHead(scenario === "error" ? 500 : 200); res.end('{"id":"not-provider"}'); }
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const routed = ((options: RequestOptions, callback: (incoming: IncomingMessage) => void) => request({ ...options as object, socketPath }, callback)) as typeof request;
    try {
      const transport = createSub2ApiTransport({ requestTimeoutMs: 100, privateTestExpiresAt: Math.floor(Date.now()/1000)+60 }, { request: routed, lstat: inspect, effectiveUid: 10001 });
      if (scenario === "error" || scenario === "no-id") { const result = await transport.fetch(url, init); assert.equal(result.headers.get("x-request-id"), null); assert.equal(result.headers.get("x-zaoshi-provider-request-id"), scenario === "no-id" ? null : "real-failure-id"); }
      else await assert.rejects(transport.fetch(url, init), (error: unknown) => Boolean(error && typeof error === "object" && "providerRequestId" in error && error.providerRequestId === "real-failure-id"));
      assert.equal(posts, 1);
    } finally { live.forEach((res) => res.destroy()); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(directory,{recursive:true,force:true}); }
  }
});
