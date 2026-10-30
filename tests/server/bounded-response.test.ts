import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../../lib/server/api";
import { readBoundedJsonResponse } from "../../lib/server/bounded-response";

const options = { maxBytes: 24, tooLargeCode: "TOO_LARGE", invalidCode: "INVALID", label: "测试服务" };

test("bounded JSON response accepts a small object", async () => {
  const parsed = await readBoundedJsonResponse<{ ok: boolean }>(new Response('{"ok":true}'), options);
  assert.deepEqual(parsed, { ok: true });
});

test("bounded JSON response rejects declared, streamed, and malformed bodies", async () => {
  await assert.rejects(
    readBoundedJsonResponse(new Response("{}", { headers: { "Content-Length": "25" } }), options),
    (error: unknown) => error instanceof ApiError && error.code === "TOO_LARGE",
  );
  await assert.rejects(
    readBoundedJsonResponse(new Response(`{"value":"${"x".repeat(40)}"}`), options),
    (error: unknown) => error instanceof ApiError && error.code === "TOO_LARGE",
  );
  await assert.rejects(
    readBoundedJsonResponse(new Response("not-json"), options),
    (error: unknown) => error instanceof ApiError && error.code === "INVALID",
  );
});
