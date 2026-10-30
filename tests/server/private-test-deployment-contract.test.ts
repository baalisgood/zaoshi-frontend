import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const compose = readFileSync("deploy/cvm/private-test.compose.yaml", "utf8");
const script = readFileSync("deploy/cvm/private-test-safe.sh", "utf8");

test("private-test stack is isolated, loopback-only and keeps provider keys out of Web", () => {
  const [web, consumer = ""] = compose.split("  private-test-consumer:");
  assert.match(web, /container_name: zaoshi-web-private-test/u);
  assert.match(web, /published: "3001"[\s\S]*host_ip: 127\.0\.0\.1/u);
  assert.match(web, /ZAOSHI_SQLITE_PATH: \/var\/lib\/zaoshi\/web-private-test\/db\/zaoshi\.sqlite/u);
  assert.match(web, /AUTH_MODE: private-test/u);
  assert.doesNotMatch(web, /seedream-api-key|qwen-api-key|ARK_API_KEY|DASHSCOPE_API_KEY/u);
  assert.match(consumer, /ZAOSHI_PROVIDER_TIMEOUT_MS: "300000"/u);
  assert.match(consumer, /stop_grace_period: 15m/u);
  assert.match(consumer, /\/var\/lib\/zaoshi\/consumer\/\.consumer\.lock:\/var\/lib\/zaoshi\/\.consumer\.lock/u);
  assert.match(consumer, /\/etc\/zaoshi\/private-test\/seedream-api-key:\/run\/secrets\/seedream-api-key:ro/u);
  assert.match(consumer, /\/etc\/zaoshi\/private-test\/qwen-api-key:\/run\/secrets\/qwen-api-key:ro/u);
  assert.doesNotMatch(consumer, /session-secret|access-secret|queue-ticket|web-private-test\/db|web-private-test\/objects/u);
  assert.match(compose, /read_only: true/g);
  assert.match(compose, /user: "10001:10001"/g);
  assert.doesNotMatch(compose, /0\.0\.0\.0:3001|published: "80"|published: "443"/u);
});

test("private-test wrapper accepts only bounded actions, immutable images and protected paths", () => {
  assert.equal(statSync("deploy/cvm/private-test-safe.sh").mode & 0o777, 0o755);
  assert.match(script, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(script, /expiry > now \+ 86400/u);
  assert.match(script, /10001:10001:700/u);
  assert.match(script, /10001:10001:400/u);
  assert.ok(script.includes("docker stop --timeout 900"));
  assert.ok(script.includes("/var/lib/zaoshi/web-private-test /var/lib/zaoshi/consumer"));
  assert.ok(script.includes("/etc/zaoshi/private-test"));
  assert.match(script, /zaoshi-generation-consumer/u);
  assert.ok(script.includes('/var/lib/zaoshi/overseas-sockets/sub2api.sock'));
  assert.ok(script.includes('$name-gateway-key'));
  assert.doesNotMatch(script, /overseas-sockets\/\$name\.sock|\$name-api-key/u);
  const relay = readFileSync("deploy/cvm/overseas-relay.service.example", "utf8");
  assert.ok(relay.includes('-L /var/lib/zaoshi/overseas-sockets/sub2api.sock:127.0.0.1:8080'));
  assert.doesNotMatch(relay, /openai\.sock|google\.sock|api\.openai\.com:443/u);
  assert.doesNotMatch(script, /down --volumes|rm -rf|docker system prune/u);
});

test("private-test stop and status still work after expiry", () => {
  const directory = mkdtempSync(join(tmpdir(), "zaoshi-private-stop-"));
  try {
    const docker = join(directory, "docker");
    writeFileSync(docker, "#!/bin/sh\ncase \"$1\" in inspect) case \"$3\" in *State.Running*) echo \"${TEST_CONSUMER_RUNNING:-false}\";; *) echo zaoshi-web-private-test;; esac;; stop) echo stopped:\"$3\":\"$4\";; ps) echo private-test-status;; *) exit 1;; esac\n");
    chmodSync(docker, 0o755);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, PRIVATE_TEST_EXPIRES_AT: "1", ZAOSHI_WEB_IMAGE_TAG: "", ZAOSHI_QWEN_WORKSPACE_ID: "" };
    const stop = spawnSync("bash", ["deploy/cvm/private-test-safe.sh", "web-down"], { env, encoding: "utf8" });
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, /stopped:30:zaoshi-web-private-test/u);
    const consumer = spawnSync("bash", ["deploy/cvm/private-test-safe.sh", "consumer-down"], { env, encoding: "utf8" });
    assert.equal(consumer.status, 0, consumer.stderr);
    assert.match(consumer.stdout, /stopped:900:zaoshi-generation-consumer-private-test/u);
    const busy = spawnSync("bash", ["deploy/cvm/private-test-safe.sh", "web-down"], { env: { ...env, TEST_CONSUMER_RUNNING: "true" }, encoding: "utf8" });
    assert.equal(busy.status, 73);
    assert.doesNotMatch(busy.stdout, /stopped:/u);
    const status = spawnSync("bash", ["deploy/cvm/private-test-safe.sh", "status"], { env, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /private-test-status/u);
  } finally { rmSync(directory, { recursive: true }); }
});
