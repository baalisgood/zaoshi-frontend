import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("active-item acceptance stack has no provider path and shares the provider lock", async () => {
  const [compose, dockerfile, wrapper] = await Promise.all([
    readFile("deploy/cvm/active-item-test.compose.yaml", "utf8"),
    readFile("deploy/cvm/active-item-test.Dockerfile", "utf8"),
    readFile("deploy/cvm/active-item-test-safe.sh", "utf8"),
  ]);
  const web = compose.slice(0, compose.indexOf("  acceptance-admin:"));
  const admin = compose.slice(
    compose.indexOf("  acceptance-admin:"),
    compose.indexOf("  acceptance-probe:"),
  );
  const probe = compose.slice(
    compose.indexOf("  acceptance-probe:"),
    compose.lastIndexOf("\nnetworks:\n"),
  );

  assert.match(web, /GENERATION_QUEUE_ACCEPTANCE_ENABLED: "1"/u);
  assert.match(web, /GENERATION_QUEUE_LEASE_SECONDS: "30"/u);
  assert.match(web, /GENERATION_INTERNAL_API_ENABLED: "1"/u);
  assert.match(web, /aliases:\s+- zaoshi-web/u);
  assert.doesNotMatch(web, /ports:|provider-egress/u);
  assert.match(admin, /network_mode: none/u);
  assert.match(admin, /restart: "no"/u);
  assert.match(probe, /restart: "no"/u);
  assert.match(probe, /ZAOSHI_CONTROL_PLANE_URL: http:\/\/zaoshi-web:3000\//u);
  assert.match(
    probe,
    /\/var\/lib\/zaoshi\/consumer\/\.consumer\.lock:\/var\/lib\/zaoshi\/execution\/\.consumer\.lock/u,
  );
  assert.doesNotMatch(probe, /provider-egress|seedream-api-key|qwen-api-key/u);
  assert.doesNotMatch(compose, /ARK_API_KEY|DASHSCOPE_API_KEY/u);
  assert.match(compose, /acceptance-control:\s+internal: true/u);
  assert.match(wrapper, /provider consumer must be stopped/u);
  assert.match(wrapper, /shared provider-consumer lock must be a regular file/u);
  assert.match(wrapper, /seed\|run\|recover\|sweep\|inspect\|web-up\|web-down/u);
  assert.doesNotMatch(wrapper, /\b(cleanup|delete)\b|(?:^|\s)rm\s|down --volumes/u);
  assert.match(dockerfile, /npm run build:acceptance/u);
  assert.doesNotMatch(dockerfile, /build:consumer|consumer\.mjs/u);
});
