import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readConsumerDaemonConfig } from "../../lib/consumer/config";

test("consumer config requires both providers and reads secrets only from files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-consumer-config-"));
  const secretRoot = join(parent, "secrets");
  try {
    await mkdir(secretRoot, { mode: 0o700 });
    await writeFile(join(secretRoot, "hmac"), "h".repeat(40), { mode: 0o600 });
    await writeFile(join(secretRoot, "seedream"), "seedream-key", { mode: 0o600 });
    await writeFile(join(secretRoot, "qwen"), "qwen-api-key", { mode: 0o600 });
    const environment = validEnvironment(parent, secretRoot);
    const config = await readConsumerDaemonConfig(environment, { secretRoot });
    assert.equal(config.controlPlaneUrl, "https://zaoshi.example/");
    assert.equal(config.controlPlaneTransport, "https");
    assert.equal(config.slots.seedream.apiKey, "seedream-key");
    assert.equal(config.slots.qwen.apiKey, "qwen-api-key");
    assert.equal(config.providerRequestTimeoutMs, 120_000);
    environment.ZAOSHI_PROVIDER_TIMEOUT_MS = "300000";
    assert.equal((await readConsumerDaemonConfig(environment, { secretRoot })).providerRequestTimeoutMs, 300_000);
    environment.ZAOSHI_PROVIDER_TIMEOUT_MS = "300001";
    await assert.rejects(readConsumerDaemonConfig(environment, { secretRoot }), /INVALID_CONSUMER_NUMBER/u);
    delete environment.ZAOSHI_PROVIDER_TIMEOUT_MS;
    assert.equal(JSON.stringify(config).includes("_FILE"), false);

    await writeFile(join(secretRoot, "openai-gateway-key"), "gateway-token", { mode: 0o600 });
    environment.ZAOSHI_OPENAI_GATEWAY_KEY_FILE = join(secretRoot, "openai-gateway-key");
    environment.ZAOSHI_OPENAI_SLOT_ID = "openai-private";
    assert.equal((await readConsumerDaemonConfig(environment, { secretRoot })).slots.openai?.apiKey, "gateway-token");
    environment.ZAOSHI_OPENAI_API_KEY_FILE = join(secretRoot, "openai-gateway-key");
    await assert.rejects(readConsumerDaemonConfig(environment, { secretRoot }), /OVERSEAS_DIRECT_KEY_FORBIDDEN/u);
    delete environment.ZAOSHI_OPENAI_API_KEY_FILE;

    environment.PUBLIC_IMAGE_GENERATION_ENABLED = "1";
    environment.BACKEND_PROFILE = "cn-production"; environment.AUTH_MODE = "email"; environment.OVERSEAS_RELAY_ENABLED = "1";
    await assert.rejects(readConsumerDaemonConfig(environment, { secretRoot }), /PUBLIC_GENERATION_NOT_CONFIGURED/u);
    environment.ZAOSHI_GOOGLE_GATEWAY_KEY_FILE = join(secretRoot, "openai-gateway-key"); environment.ZAOSHI_GOOGLE_SLOT_ID = "google-production";
    assert.equal((await readConsumerDaemonConfig(environment, { secretRoot })).publicGenerationEnabled, true);
    environment.PRIVATE_TEST_EXPIRES_AT = String(Math.floor(Date.now()/1000)+3600);
    await assert.rejects(readConsumerDaemonConfig(environment, { secretRoot }), /PUBLIC_GENERATION_NOT_CONFIGURED/u);
    delete environment.PRIVATE_TEST_EXPIRES_AT;
    environment.PUBLIC_IMAGE_GENERATION_ENABLED = "0";
    delete environment.ZAOSHI_QWEN_SLOT_ID;
    await assert.rejects(
      readConsumerDaemonConfig(environment, { secretRoot }),
      /INVALID_CONSUMER_IDENTIFIER/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("consumer config permits only the exact private Docker control origin", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-consumer-private-control-"));
  const secretRoot = join(parent, "secrets");
  try {
    await mkdir(secretRoot, { mode: 0o700 });
    await writeFile(join(secretRoot, "hmac"), "h".repeat(40), { mode: 0o600 });
    await writeFile(join(secretRoot, "seedream"), "seedream-key", { mode: 0o600 });
    await writeFile(join(secretRoot, "qwen"), "qwen-api-key", { mode: 0o600 });
    const environment = validEnvironment(parent, secretRoot);
    environment.ZAOSHI_CONTROL_PLANE_TRANSPORT = "private-docker";
    environment.ZAOSHI_CONTROL_PLANE_URL = "http://zaoshi-web:3000/";
    const config = await readConsumerDaemonConfig(environment, { secretRoot });
    assert.equal(config.controlPlaneTransport, "private-docker");
    assert.equal(config.controlPlaneUrl, "http://zaoshi-web:3000/");

    for (const value of [
      "http://127.0.0.1:3000/",
      "http://zaoshi-web/",
      "http://zaoshi-web:3001/",
      "http://zaoshi-web:3000/path",
      "https://zaoshi-web:3000/",
    ]) {
      environment.ZAOSHI_CONTROL_PLANE_URL = value;
      await assert.rejects(
        readConsumerDaemonConfig(environment, { secretRoot }),
        /INVALID_CONTROL_PLANE_URL/u,
      );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("consumer config rejects secret symlinks, direct secret values and arbitrary URLs", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-consumer-config-link-"));
  const secretRoot = join(parent, "secrets");
  try {
    await mkdir(secretRoot, { mode: 0o700 });
    await writeFile(join(secretRoot, "real"), "h".repeat(40), { mode: 0o600 });
    await symlink(join(secretRoot, "real"), join(secretRoot, "hmac"));
    await writeFile(join(secretRoot, "seedream"), "seedream-key", { mode: 0o600 });
    await writeFile(join(secretRoot, "qwen"), "qwen-api-key", { mode: 0o600 });
    const environment = validEnvironment(parent, secretRoot);
    environment.ZAOSHI_CONSUMER_SECRET = "must-not-be-consumed";
    await assert.rejects(
      readConsumerDaemonConfig(environment, { secretRoot }),
      /CONSUMER_SECRET_FILE_UNSAFE/u,
    );

    environment.ZAOSHI_CONSUMER_SECRET_FILE = join(secretRoot, "real");
    environment.ZAOSHI_CONTROL_PLANE_URL = "https://zaoshi.example/path";
    await assert.rejects(
      readConsumerDaemonConfig(environment, { secretRoot }),
      /INVALID_CONTROL_PLANE_URL/u,
    );
    environment.ZAOSHI_CONTROL_PLANE_URL = "https://user:pass@zaoshi.example/";
    await assert.rejects(
      readConsumerDaemonConfig(environment, { secretRoot }),
      /INVALID_CONTROL_PLANE_URL/u,
    );

    environment.ZAOSHI_CONTROL_PLANE_URL = "https://zaoshi.example/";
    await chmod(join(secretRoot, "seedream"), 0o644);
    await assert.rejects(
      readConsumerDaemonConfig(environment, { secretRoot }),
      /SEEDREAM_API_KEY_FILE_UNSAFE/u,
    );
    await chmod(join(secretRoot, "seedream"), 0o600);

    await chmod(join(secretRoot, "seedream"), 0o700);
    await assert.rejects(
      readConsumerDaemonConfig(environment, { secretRoot }),
      /SEEDREAM_API_KEY_FILE_UNSAFE/u,
    );
    await chmod(join(secretRoot, "seedream"), 0o600);

    const outside = join(parent, "outside");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "qwen"), "qwen-api-key", { mode: 0o600 });
    await symlink(outside, join(secretRoot, "nested"));
    environment.ZAOSHI_QWEN_API_KEY_FILE = join(secretRoot, "nested", "qwen");
    await assert.rejects(
      readConsumerDaemonConfig(environment, { secretRoot }),
      /QWEN_API_KEY_FILE_UNSAFE/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function validEnvironment(
  parent: string,
  secretRoot: string,
): Record<string, string | undefined> {
  return {
    ZAOSHI_CONTROL_PLANE_URL: "https://zaoshi.example/",
    ZAOSHI_CONSUMER_WORKER_ID: "worker-1",
    ZAOSHI_CONSUMER_KEY_ID: "key-1",
    ZAOSHI_CONSUMER_AUDIENCE: "audience-1",
    ZAOSHI_CONSUMER_SECRET_FILE: join(secretRoot, "hmac"),
    ZAOSHI_SPOOL_ROOT: join(parent, "spool"),
    ZAOSHI_HEALTH_FILE: join(parent, "run", "health.json"),
    ZAOSHI_SEEDREAM_SLOT_ID: "seedream-primary",
    ZAOSHI_SEEDREAM_API_KEY_FILE: join(secretRoot, "seedream"),
    ZAOSHI_QWEN_SLOT_ID: "qwen-primary",
    ZAOSHI_QWEN_API_KEY_FILE: join(secretRoot, "qwen"),
    ZAOSHI_QWEN_WORKSPACE_ID: "workspace_1",
  };
}
