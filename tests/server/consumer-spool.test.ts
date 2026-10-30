import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSystemConsumerSpool } from "../../lib/consumer/spool";

const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

test("filesystem spool writes private atomic files and reads them after restart", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-test-"));
  const root = join(parent, "spool");
  try {
    const record = {
      version: 1 as const,
      executionKind: "provider" as const,
      attemptId: "attempt-spool-1",
      fence: {
        itemId: "qitem-spool-1",
        leaseToken: "lease-spool-1",
        leaseGeneration: 1,
      },
      uploadRequestId: "upload-spool-1",
      providerRequestId: "provider-spool-1",
      promptTemplateVersion: "interior-concept-v4",
      sanitizationVersion: "canonical-image-v1",
      mimeType: "image/png",
      byteSize: PNG_BYTES.byteLength,
      sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
    };
    const spool = new FileSystemConsumerSpool(root);
    await spool.save(record, PNG_BYTES);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal(
      (await lstat(join(root, record.attemptId, "output.bin"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await lstat(join(root, record.attemptId, "state.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await readFile(join(root, record.attemptId, "state.json"), "utf8")).includes(
        "provider-spool-1",
      ),
      true,
    );
    const restarted = new FileSystemConsumerSpool(root);
    const [pending] = await restarted.list();
    assert.deepEqual(pending, record);
    assert.deepEqual(await restarted.read(pending!), PNG_BYTES);
    await restarted.remove(record);
    assert.equal((await restarted.list()).length, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem spool preserves legacy provider records as unproven", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-legacy-test-"));
  const root = join(parent, "spool");
  const record = spoolRecord("attempt-legacy-v1");
  try {
    const spool = new FileSystemConsumerSpool(root);
    await spool.save(record, PNG_BYTES);
    const statePath = join(root, record.attemptId, "state.json");
    const legacy = JSON.parse(await readFile(statePath, "utf8")) as Record<
      string,
      unknown
    >;
    delete legacy.executionKind;
    delete legacy.sanitizationVersion;
    await writeFile(statePath, JSON.stringify(legacy), { mode: 0o600 });

    const [pending] = await new FileSystemConsumerSpool(root).list();
    assert.deepEqual(pending, { ...record, sanitizationVersion: null });
    assert.deepEqual(await spool.read(pending!), PNG_BYTES);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem spool refuses a symlinked root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-link-test-"));
  const real = join(parent, "real");
  const linked = join(parent, "linked");
  try {
    const bootstrap = new FileSystemConsumerSpool(real);
    assert.equal((await bootstrap.list()).length, 0);
    await symlink(real, linked);
    await assert.rejects(
      new FileSystemConsumerSpool(linked).list(),
      /UNSAFE_SPOOL_DIRECTORY/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem spool promotes a complete staging directory after restart", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-stage-test-"));
  const root = join(parent, "spool");
  const record = spoolRecord("attempt-stage-1");
  try {
    const spool = new FileSystemConsumerSpool(root);
    await spool.save(record, PNG_BYTES);
    await rename(
      join(root, record.attemptId),
      join(root, `.staging-${record.attemptId}-crash-window`),
    );
    const restarted = new FileSystemConsumerSpool(root);
    assert.deepEqual(await restarted.list(), [record]);
    assert.deepEqual(await restarted.read(record), PNG_BYTES);
    assert.equal((await lstat(join(root, record.attemptId))).isDirectory(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem spool quarantines a corrupt first record without starving later output", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-corrupt-test-"));
  const root = join(parent, "spool");
  const valid = spoolRecord("attempt-z-valid");
  try {
    const spool = new FileSystemConsumerSpool(root);
    await spool.save(valid, PNG_BYTES);
    const corruptDirectory = join(root, "attempt-a-corrupt");
    await mkdir(corruptDirectory, { mode: 0o700 });
    await writeFile(join(corruptDirectory, "state.json"), "not-json", {
      mode: 0o600,
    });
    assert.deepEqual(await spool.list(), [valid]);
    const quarantined = await readdir(join(root, ".quarantine"));
    assert.equal(
      quarantined.some((name) => name.startsWith("attempt-a-corrupt-")),
      true,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem spool does not follow a predictable temporary-file symlink", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-part-link-test-"));
  const root = join(parent, "spool");
  const victim = join(parent, "victim.txt");
  const record = spoolRecord("attempt-random-part");
  try {
    await mkdir(root, { mode: 0o700 });
    await writeFile(victim, "unchanged");
    await symlink(victim, join(root, "output.bin.part"));
    const spool = new FileSystemConsumerSpool(root);
    await spool.save(record, PNG_BYTES);
    assert.equal(await readFile(victim, "utf8"), "unchanged");
    assert.deepEqual(await spool.read(record), PNG_BYTES);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem spool bounds quarantine by age and oldest-first entry cap", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-maintain-test-"));
  const root = join(parent, "spool");
  try {
    const spool = new FileSystemConsumerSpool(root);
    for (const name of ["attempt-old", "attempt-middle", "attempt-new"]) {
      const record = spoolRecord(name);
      await spool.save(record, PNG_BYTES);
      await spool.quarantine(record, "terminal-control-plane");
    }
    const quarantineRoot = join(root, ".quarantine");
    const names = (await readdir(quarantineRoot)).sort();
    const now = Date.now();
    for (const name of names) {
      const age = name.includes("attempt-old")
        ? 10 * 24 * 60 * 60 * 1_000
        : name.includes("attempt-middle")
          ? 2_000
          : 1_000;
      const date = new Date(now - age);
      await utimes(join(quarantineRoot, name), date, date);
    }
    const result = await spool.maintainQuarantine({
      nowMs: now,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEntries: 1,
      maxBytes: 1_000_000,
    });
    assert.equal(result.inspected, 3);
    assert.equal(result.removed, 2);
    assert.equal(result.retained, 1);
    const retained = await readdir(quarantineRoot);
    assert.equal(retained.length, 1);
    assert.match(retained[0]!, /attempt-new/u);

    const active = spoolRecord("attempt-active");
    await spool.save(active, PNG_BYTES);
    const byteBounded = await spool.maintainQuarantine({
      nowMs: now,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      maxEntries: 100,
      maxBytes: 1,
    });
    assert.equal(byteBounded.removed, 1);
    assert.equal(byteBounded.retained, 0);
    assert.deepEqual(await spool.list(), [active]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("filesystem spool maintenance rejects quarantine symlinks without following them", async () => {
  const parent = await mkdtemp(join(tmpdir(), "zaoshi-spool-maintain-link-test-"));
  const root = join(parent, "spool");
  const outside = join(parent, "outside");
  try {
    const spool = new FileSystemConsumerSpool(root);
    await spool.list();
    await mkdir(join(root, ".quarantine"), { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(root, ".quarantine", "unsafe-link"));
    await assert.rejects(
      spool.maintainQuarantine({
        nowMs: Date.now(),
        retentionMs: 1,
        maxEntries: 1,
        maxBytes: 1,
      }),
      /UNSAFE_QUARANTINE_ENTRY/u,
    );
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

function spoolRecord(attemptId: string) {
  return {
    version: 1 as const,
    executionKind: "provider" as const,
    attemptId,
    fence: {
      itemId: `qitem-${attemptId}`,
      leaseToken: `lease-${attemptId}`,
      leaseGeneration: 1,
    },
    uploadRequestId: `upload-${attemptId}`,
    providerRequestId: `provider-${attemptId}`,
    promptTemplateVersion: "interior-concept-v4",
    sanitizationVersion: "canonical-image-v1",
    mimeType: "image/png",
    byteSize: PNG_BYTES.byteLength,
    sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
  };
}
