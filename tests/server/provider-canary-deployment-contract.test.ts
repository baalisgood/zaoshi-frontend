import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function runWrapper(webTag: string, canaryTag: string, ...args: string[]) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["deploy/cvm/provider-canary-safe.sh", ...args], {
      env: {
        ...process.env,
        ZAOSHI_WEB_IMAGE_TAG: webTag,
        ZAOSHI_CANARY_IMAGE_TAG: canaryTag,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

test("provider Canary deployment is isolated, one-shot and Seedream-only", async () => {
  const [compose, dockerfile, wrapper, entry, fixture] = await Promise.all([
    readFile("deploy/cvm/provider-canary.compose.yaml", "utf8"),
    readFile("deploy/cvm/provider-canary.Dockerfile", "utf8"),
    readFile("deploy/cvm/provider-canary-safe.sh", "utf8"),
    readFile("scripts/generation-provider-canary.ts", "utf8"),
    readFile("lib/canary/provider-fixture.ts", "utf8"),
  ]);
  const web = compose.slice(0, compose.indexOf("  canary-admin:"));
  const admin = compose.slice(
    compose.indexOf("  canary-admin:"),
    compose.indexOf("  canary-runner:"),
  );
  const runner = compose.slice(
    compose.indexOf("  canary-runner:"),
    compose.indexOf("  canary-recover:"),
  );
  const recovery = compose.slice(
    compose.indexOf("  canary-recover:"),
    compose.indexOf("  canary-probe:"),
  );
  const probe = compose.slice(
    compose.indexOf("  canary-probe:"),
    compose.lastIndexOf("\nnetworks:\n"),
  );

  assert.match(web, /BACKEND_PROFILE: sites-demo/u);
  assert.match(web, /TRUST_PLATFORM_IDENTITY_HEADERS: "0"/u);
  assert.match(web, /GENERATION_INTERNAL_API_ENABLED: "1"/u);
  assert.doesNotMatch(web, /ports:|provider-canary-egress|seedream-api-key/u);
  assert.match(admin, /network_mode: none/u);
  assert.doesNotMatch(admin, /seedream-api-key|provider-canary-hmac/u);
  assert.match(runner, /restart: "no"/u);
  assert.match(runner, /provider-canary-egress:\s+gw_priority: 1/u);
  assert.match(runner, /seedream-api-key/u);
  assert.match(
    runner,
    /\/var\/lib\/zaoshi\/consumer\/\.consumer\.lock:\/var\/lib\/zaoshi\/execution\/\.consumer\.lock/u,
  );
  assert.doesNotMatch(runner, /qwen|queue-ticket|provider-canary\/db|provider-canary\/objects/u);
  assert.doesNotMatch(recovery, /provider-canary-egress|seedream-api-key|qwen/u);
  assert.match(recovery, /provider-canary-hmac/u);
  assert.doesNotMatch(probe, /provider-canary-egress|seedream-api-key|provider-canary-hmac/u);
  assert.match(compose, /provider-canary-control:\s+internal: true/u);
  assert.doesNotMatch(compose, /ARK_API_KEY|DASHSCOPE_API_KEY/u);
  assert.match(wrapper, /--confirm-cost=ONE_SEEDREAM_45_IMAGE/u);
  assert.match(wrapper, /normal provider consumer must be stopped/u);
  assert.doesNotMatch(wrapper, /(?:^|\s)rm\s|down --volumes|restart:/u);
  assert.match(dockerfile, /npm run build:provider-canary/u);
  assert.match(dockerfile, /\/app\/node_modules\/@img\//u);
  assert.doesNotMatch(dockerfile, /build:consumer|consumer\.mjs/u);
  assert.match(fixture, /doubao-seedream-4-5-251128/u);
  assert.match(entry, /providerRequestTimeoutMs: 120_000/u);
  assert.match(entry, /createProviderCanaryExecutor/u);
  assert.match(entry, /createDurablePaidRunMarker/u);
  assert.match(entry, /result\.status !== "completed"/u);
  assert.match(entry, /process\.argv\.length !== 4/u);
  assert.doesNotMatch(entry, /DASHSCOPE|qwen/u);
});

test("provider Canary wrapper rejects unsafe tags and missing cost confirmation", async () => {
  const full = "a".repeat(40);
  for (const [webTag, canaryTag, args] of [
    ["latest", full, ["seed"]],
    [full, "local", ["seed"]],
    [full, "b".repeat(40), ["seed"]],
    [full, full, ["run"]],
    [full, full, ["run", "--confirm-cost=WRONG"]],
  ] as const) {
    const result = await runWrapper(webTag, canaryTag, ...args);
    assert.equal(result.code, 64);
  }
});
