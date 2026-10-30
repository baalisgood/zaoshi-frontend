import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  consumerHealthcheck,
  FileConsumerHealthReporter,
  readConsumerHealth,
  type ConsumerHealthSnapshot,
} from "../../lib/consumer/health";

test("consumer health file is private, bounded and excludes operational secrets", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-health-"));
  const path = join(parent, "run", "health.json");
  try {
    const now = Date.now();
    const snapshot = healthSnapshot(new Date(now).toISOString());
    await new FileConsumerHealthReporter(path).write(snapshot);
    assert.equal(await consumerHealthcheck(path, { nowMs: now }), true);
    assert.equal((await readConsumerHealth(path, { nowMs: now })).status, "ready");
    const body = await readFile(path, "utf8");
    assert.equal(body.includes("secret"), false);
    assert.equal(body.includes("prompt"), false);

    snapshot.state = "degraded";
    await new FileConsumerHealthReporter(path).write(snapshot);
    assert.equal(await consumerHealthcheck(path, { nowMs: now }), false);
    assert.equal((await readConsumerHealth(path, { nowMs: now })).status, "degraded");

    snapshot.state = "ready";
    snapshot.updatedAt = new Date(now - 121_000).toISOString();
    await new FileConsumerHealthReporter(path).write(snapshot);
    assert.equal(await consumerHealthcheck(path, { nowMs: now }), false);
    assert.equal((await readConsumerHealth(path, { nowMs: now })).status, "stale");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("consumer health reader rejects corrupt, oversized and symlinked files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-health-invalid-"));
  try {
    const path = join(parent, "health.json");
    await writeFile(path, "not-json");
    await chmod(path, 0o600);
    assert.equal((await readConsumerHealth(path)).status, "unavailable");
    await writeFile(path, "x".repeat(16 * 1024 + 1));
    assert.equal((await readConsumerHealth(path)).status, "unavailable");

    const real = join(parent, "real.json");
    await writeFile(real, JSON.stringify(healthSnapshot(new Date().toISOString())));
    await chmod(real, 0o600);
    const fileLink = join(parent, "health-link.json");
    await symlink(real, fileLink);
    assert.equal((await readConsumerHealth(fileLink)).status, "unavailable");

    const directory = join(parent, "real-directory");
    await mkdir(directory);
    await writeFile(join(directory, "health.json"), JSON.stringify(healthSnapshot(new Date().toISOString())));
    await chmod(join(directory, "health.json"), 0o600);
    const directoryLink = join(parent, "health-directory-link");
    await symlink(directory, directoryLink);
    assert.equal((await readConsumerHealth(join(directoryLink, "health.json"))).status, "unavailable");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("consumer health reader rejects writable directories and broadly readable files", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-health-mode-"));
  try {
    const file = join(parent, "health.json");
    await writeFile(file, JSON.stringify(healthSnapshot(new Date().toISOString())));
    await chmod(file, 0o644);
    assert.equal((await readConsumerHealth(file)).status, "unavailable");

    const unsafeDirectory = join(parent, "unsafe");
    await mkdir(unsafeDirectory);
    await chmod(unsafeDirectory, 0o777);
    const privateFile = join(unsafeDirectory, "health.json");
    await writeFile(privateFile, JSON.stringify(healthSnapshot(new Date().toISOString())));
    await chmod(privateFile, 0o600);
    assert.equal((await readConsumerHealth(privateFile)).status, "unavailable");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function healthSnapshot(now: string): ConsumerHealthSnapshot {
  return {
    version: 1,
    state: "ready",
    startedAt: now,
    updatedAt: now,
    lastSuccessAt: now,
    lastErrorCode: null,
    counters: {
      completed: 0,
      safeFailures: 0,
      reconciliationRequired: 0,
      controlPlaneFailures: 0,
      sweeps: 1,
      quarantineRemoved: 0,
    },
  };
}
