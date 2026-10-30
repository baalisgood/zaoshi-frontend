import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function runSafeStack(webTag: string, consumerTag: string) {
  return new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["deploy/cvm/stack-safe.sh", "config"], {
      env: {
        ...process.env,
        ZAOSHI_WEB_IMAGE_TAG: webTag,
        ZAOSHI_CONSUMER_IMAGE_TAG: consumerTag,
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

test("CVM private stack isolates Web data, provider secrets and control transport", async () => {
  const [compose, safeStack, webEnvironment, consumerEnvironment] = await Promise.all([
    readFile("deploy/cvm/stack.compose.yaml", "utf8"),
    readFile("deploy/cvm/stack-safe.sh", "utf8"),
    readFile("deploy/cvm/web.env.example", "utf8"),
    readFile("deploy/cvm/consumer.env.example", "utf8"),
  ]);
  assert.match(
    compose,
    /ports:\s+- target: 3000\s+published: "3000"\s+host_ip: 127\.0\.0\.1\s+protocol: tcp/u,
  );
  assert.match(compose, /queue-control:\s+internal: true/u);
  assert.match(
    compose,
    /web-loopback-publish:\s+driver: bridge\s+driver_opts:\s+com\.docker\.network\.bridge\.host_binding_ipv4: "127\.0\.0\.1"\s+com\.docker\.network\.bridge\.enable_ip_masquerade: "false"/u,
  );
  const webService = compose.slice(0, compose.indexOf("  generation-consumer:"));
  const consumerService = compose.slice(
    compose.indexOf("  generation-consumer:"),
    compose.indexOf("networks:\n  queue-control:"),
  );
  assert.match(webService, /queue-control: \{\}/u);
  assert.match(webService, /web-loopback-publish:\s+gw_priority: 1/u);
  assert.doesNotMatch(webService, /provider-egress/u);
  assert.match(webService, /\/var\/lib\/zaoshi\/consumer-health:\/var\/lib\/zaoshi\/consumer-health:ro/u);
  assert.doesNotMatch(webService, /\/var\/lib\/zaoshi\/consumer:\/var\/lib\/zaoshi(?!\/consumer-health)/u);
  assert.doesNotMatch(webService, /seedream-api-key|qwen-api-key/u);
  assert.match(webService, /BACKEND_PROFILE: sites-demo/u);
  assert.match(webService, /TRUST_PLATFORM_IDENTITY_HEADERS: "0"/u);
  assert.match(webService, /GENERATION_INTERNAL_API_ENABLED: "0"/u);
  assert.match(consumerService, /queue-control: \{\}/u);
  assert.match(consumerService, /provider-egress:\s+gw_priority: 1/u);
  assert.doesNotMatch(consumerService, /web-loopback-publish/u);
  assert.match(consumerService, /\/var\/lib\/zaoshi\/consumer-health:\/var\/lib\/zaoshi\/consumer-health(?:\s|$)/u);
  assert.match(compose, /\/etc\/zaoshi\/secrets\/queue-ticket:\/run\/secrets\/queue-ticket:ro/u);
  assert.equal((compose.match(/\/run\/secrets\/queue-ticket/gu) ?? []).length, 1);
  assert.equal((compose.match(/\/run\/secrets\/seedream-api-key/gu) ?? []).length, 1);
  assert.equal((compose.match(/\/run\/secrets\/qwen-api-key/gu) ?? []).length, 1);
  assert.doesNotMatch(compose, /generation-consumer:[\s\S]*\/var\/lib\/zaoshi\/db/u);
  assert.doesNotMatch(compose, /generation-consumer:[\s\S]*\/var\/lib\/zaoshi\/objects/u);
  assert.match(webEnvironment, /GENERATION_INTERNAL_API_ENABLED=0/u);
  assert.match(webEnvironment, /GENERATION_INTERNAL_TRANSPORT=private-docker/u);
  assert.doesNotMatch(webEnvironment, /ARK_API_KEY|DASHSCOPE_API_KEY/u);
  assert.match(consumerEnvironment, /ZAOSHI_CONTROL_PLANE_TRANSPORT=private-docker/u);
  assert.match(consumerEnvironment, /ZAOSHI_CONTROL_PLANE_URL=http:\/\/zaoshi-web:3000\//u);
  assert.match(consumerEnvironment, /ZAOSHI_HEALTH_FILE=\/var\/lib\/zaoshi\/consumer-health\/health\.json/u);
  assert.match(safeStack, /web_image_tag[\s\S]*consumer_image_tag/u);
});

test("CVM private stack wrapper rejects mutable, abbreviated and mismatched tags", async () => {
  for (const [webTag, consumerTag] of [
    ["latest", "a".repeat(40)],
    ["a".repeat(40), "local"],
    ["a".repeat(40), "b".repeat(40)],
    ["ABCDEF".repeat(6).padEnd(40, "A"), "ABCDEF".repeat(6).padEnd(40, "A")],
  ]) {
    const result = await runSafeStack(webTag, consumerTag);
    assert.equal(result.code, 64, `${webTag}/${consumerTag}`);
  }
});
