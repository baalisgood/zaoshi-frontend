import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validateGeneratedImage } from "@/lib/server/files";
import type {
  ConsumerSpool,
  ConsumerSpoolMaintenance,
  SpoolMaintenanceSummary,
  SpoolRecord,
} from "./contracts";

const ATTEMPT_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/u;

export class FileSystemConsumerSpool
  implements ConsumerSpool, ConsumerSpoolMaintenance
{
  private readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error("SPOOL_ROOT_MUST_BE_ABSOLUTE");
    this.root = resolve(root);
  }

  async list(): Promise<SpoolRecord[]> {
    await this.ensureRoot();
    const records: SpoolRecord[] = [];
    for (const name of await readdir(this.root)) {
      if (/^\.staging-[A-Za-z0-9:_-]{1,220}$/u.test(name)) {
        const recovered = await this.recoverStagingDirectory(name);
        if (recovered) records.push(recovered);
        continue;
      }
      if (!ATTEMPT_PATTERN.test(name)) continue;
      const directory = this.directory(name);
      try {
        await assertRealDirectory(directory);
        const record = parseRecord(
          await readFile(join(directory, "state.json"), "utf8"),
        );
        if (record.attemptId !== name) throw new Error("SPOOL_DIRECTORY_MISMATCH");
        await readValidatedOutput(directory, record);
        records.push(record);
      } catch {
        // Preserve incomplete/corrupt paid output for operator inspection, but
        // keep it out of the active head of line so later items are not starved.
        await this.quarantineDirectory(name, "invalid-local-record");
      }
    }
    return records.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  }

  async read(record: SpoolRecord): Promise<Uint8Array> {
    const directory = this.directory(record.attemptId);
    await assertRealDirectory(directory);
    return readValidatedOutput(directory, record);
  }

  async save(record: SpoolRecord, bytes: Uint8Array): Promise<void> {
    validateRecord(record);
    const validated = validateGeneratedImage(bytes, record.mimeType);
    if (
      validated.bytes.byteLength !== record.byteSize ||
      validated.sha256 !== record.sha256
    ) {
      throw new Error("SPOOL_INTEGRITY_CONFLICT");
    }
    await this.ensureRoot();
    const directory = this.directory(record.attemptId);
    const existing = await lstat(directory).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("UNSAFE_SPOOL_DIRECTORY");
      }
      const stored = parseRecord(
        await readFile(join(directory, "state.json"), "utf8"),
      );
      if (stored.attemptId !== record.attemptId) {
        throw new Error("SPOOL_DIRECTORY_MISMATCH");
      }
      const storedBytes = await this.read(stored);
      if (
        JSON.stringify(stored) !== JSON.stringify(record) ||
        storedBytes.byteLength !== bytes.byteLength ||
        validated.sha256 !== record.sha256
      ) {
        throw new Error("SPOOL_RECORD_CONFLICT");
      }
      return;
    }
    const stagingName = `.staging-${record.attemptId}-${crypto.randomUUID()}`;
    const staging = join(this.root, stagingName);
    await mkdir(staging, { mode: 0o700 });
    await chmod(staging, 0o700);
    await atomicWrite(join(staging, "output.bin"), bytes);
    await atomicWrite(
      join(staging, "state.json"),
      new TextEncoder().encode(JSON.stringify(record)),
    );
    await fsyncDirectory(staging);
    await rename(staging, directory);
    await fsyncDirectory(this.root);
  }

  async remove(record: SpoolRecord): Promise<void> {
    const directory = this.directory(record.attemptId);
    const stat = await lstat(directory).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("UNSAFE_SPOOL_DIRECTORY");
    }
    await rm(directory, { recursive: true, force: false });
    await fsyncDirectory(this.root);
  }

  async quarantine(
    record: SpoolRecord,
    reason: "invalid-local-record" | "terminal-control-plane",
  ): Promise<void> {
    validateRecord(record);
    await this.ensureRoot();
    const source = this.directory(record.attemptId);
    const stat = await lstat(source).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("UNSAFE_SPOOL_DIRECTORY");
    }
    await this.quarantineDirectory(record.attemptId, reason);
  }

  async maintainQuarantine(input: {
    nowMs: number;
    retentionMs: number;
    maxEntries: number;
    maxBytes: number;
  }): Promise<SpoolMaintenanceSummary> {
    validateMaintenanceInput(input);
    await this.ensureRoot();
    const quarantineRoot = join(this.root, ".quarantine");
    const rootStat = await lstat(quarantineRoot).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!rootStat) {
      return { inspected: 0, removed: 0, retained: 0, retainedBytes: 0 };
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("UNSAFE_QUARANTINE_DIRECTORY");
    }

    const entries: QuarantineEntry[] = [];
    for (const name of await readdir(quarantineRoot)) {
      if (!/^[A-Za-z0-9:_.-]{1,300}$/u.test(name) || name === "." || name === "..") {
        throw new Error("UNSAFE_QUARANTINE_ENTRY");
      }
      const path = resolve(quarantineRoot, name);
      if (!path.startsWith(`${quarantineRoot}/`)) {
        throw new Error("UNSAFE_QUARANTINE_ENTRY");
      }
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("UNSAFE_QUARANTINE_ENTRY");
      }
      entries.push({
        name,
        path,
        mtimeMs: stat.mtimeMs,
        bytes: await validatedDirectorySize(path),
        dev: stat.dev,
        ino: stat.ino,
      });
    }

    const oldestFirst = entries.sort(
      (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
    );
    const removeNames = new Set(
      oldestFirst
        .filter((entry) => input.nowMs - entry.mtimeMs >= input.retentionMs)
        .map((entry) => entry.name),
    );
    const retainedEntries = oldestFirst.filter((entry) => !removeNames.has(entry.name));
    let retainedBytes = retainedEntries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (
      retainedEntries.length > input.maxEntries ||
      retainedBytes > input.maxBytes
    ) {
      const entry = retainedEntries.shift();
      if (!entry) break;
      removeNames.add(entry.name);
      retainedBytes -= entry.bytes;
    }

    let removed = 0;
    for (const entry of oldestFirst) {
      if (!removeNames.has(entry.name)) continue;
      const current = await lstat(entry.path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== entry.dev ||
        current.ino !== entry.ino
      ) {
        throw new Error("QUARANTINE_ENTRY_CHANGED");
      }
      await rm(entry.path, { recursive: true, force: false });
      removed += 1;
    }
    if (removed > 0) {
      await fsyncDirectory(quarantineRoot);
      await fsyncDirectory(this.root);
    }
    return {
      inspected: oldestFirst.length,
      removed,
      retained: retainedEntries.length,
      retainedBytes,
    };
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { mode: 0o700 });
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    await assertRealDirectory(this.root);
    await chmod(this.root, 0o700);
  }

  private directory(attemptId: string): string {
    if (!ATTEMPT_PATTERN.test(attemptId)) throw new Error("INVALID_ATTEMPT_ID");
    const target = resolve(this.root, attemptId);
    if (!target.startsWith(`${this.root}/`)) throw new Error("UNSAFE_SPOOL_PATH");
    return target;
  }

  private async quarantineDirectory(
    attemptId: string,
    reason: "invalid-local-record" | "terminal-control-plane",
  ): Promise<void> {
    const source = this.directory(attemptId);
    const quarantineRoot = join(this.root, ".quarantine");
    try {
      await mkdir(quarantineRoot, { mode: 0o700 });
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    await assertRealDirectory(quarantineRoot);
    await chmod(quarantineRoot, 0o700);
    const target = join(
      quarantineRoot,
      `${attemptId}-${reason}-${crypto.randomUUID()}`,
    );
    await rename(source, target);
    await fsyncDirectory(quarantineRoot);
    await fsyncDirectory(this.root);
  }

  private async recoverStagingDirectory(
    name: string,
  ): Promise<SpoolRecord | null> {
    const source = resolve(this.root, name);
    if (!source.startsWith(`${this.root}/`)) throw new Error("UNSAFE_SPOOL_PATH");
    try {
      await assertRealDirectory(source);
      const record = parseRecord(
        await readFile(join(source, "state.json"), "utf8"),
      );
      await readValidatedOutput(source, record);
      const target = this.directory(record.attemptId);
      const targetStat = await lstat(target).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      });
      if (targetStat) throw new Error("SPOOL_RECORD_CONFLICT");
      await rename(source, target);
      await fsyncDirectory(this.root);
      return record;
    } catch {
      await this.quarantineStagingDirectory(name);
      return null;
    }
  }

  private async quarantineStagingDirectory(name: string): Promise<void> {
    const source = resolve(this.root, name);
    if (!source.startsWith(`${this.root}/`)) throw new Error("UNSAFE_SPOOL_PATH");
    const sourceStat = await lstat(source).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!sourceStat) return;
    const quarantineRoot = join(this.root, ".quarantine");
    try {
      await mkdir(quarantineRoot, { mode: 0o700 });
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    await assertRealDirectory(quarantineRoot);
    await chmod(quarantineRoot, 0o700);
    await rename(
      source,
      join(quarantineRoot, `incomplete-stage-${crypto.randomUUID()}`),
    );
    await fsyncDirectory(quarantineRoot);
    await fsyncDirectory(this.root);
  }
}

type QuarantineEntry = {
  name: string;
  path: string;
  mtimeMs: number;
  bytes: number;
  dev: number;
  ino: number;
};

function validateMaintenanceInput(input: {
  nowMs: number;
  retentionMs: number;
  maxEntries: number;
  maxBytes: number;
}): void {
  if (
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    !Number.isSafeInteger(input.retentionMs) ||
    input.retentionMs < 1 ||
    !Number.isSafeInteger(input.maxEntries) ||
    input.maxEntries < 0 ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 0
  ) {
    throw new Error("INVALID_QUARANTINE_POLICY");
  }
}

async function validatedDirectorySize(directory: string): Promise<number> {
  const root = resolve(directory);
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const currentStat = await lstat(current);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) {
      throw new Error("UNSAFE_QUARANTINE_ENTRY");
    }
    for (const name of await readdir(current)) {
      const path = resolve(current, name);
      if (!path.startsWith(`${root}/`)) throw new Error("UNSAFE_QUARANTINE_ENTRY");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("UNSAFE_QUARANTINE_ENTRY");
      if (stat.isDirectory()) {
        pending.push(path);
      } else if (stat.isFile()) {
        total += stat.size;
        if (!Number.isSafeInteger(total)) throw new Error("QUARANTINE_SIZE_OVERFLOW");
      } else {
        throw new Error("UNSAFE_QUARANTINE_ENTRY");
      }
    }
  }
  return total;
}

async function readValidatedOutput(
  directory: string,
  record: SpoolRecord,
): Promise<Uint8Array> {
  const outputPath = join(directory, "output.bin");
  const stat = await lstat(outputPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("UNSAFE_SPOOL_FILE");
  const bytes = new Uint8Array(await readFile(outputPath));
  const validated = validateGeneratedImage(bytes, record.mimeType);
  if (
    validated.bytes.byteLength !== record.byteSize ||
    validated.sha256 !== record.sha256
  ) {
    throw new Error("SPOOL_INTEGRITY_CONFLICT");
  }
  return bytes;
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID()}.part`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("UNSAFE_SPOOL_FILE");
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await fsyncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("UNSAFE_SPOOL_DIRECTORY");
  }
}

function parseRecord(value: string): SpoolRecord {
  const parsed: unknown = JSON.parse(value);
  const normalized = normalizeLegacyRecord(parsed);
  validateRecord(normalized);
  return normalized;
}

function normalizeLegacyRecord(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).executionKind === undefined
  ) {
    return {
      ...(value as Record<string, unknown>),
      executionKind: "provider",
      sanitizationVersion: null,
    };
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).sanitizationVersion === undefined
  ) {
    return { ...(value as Record<string, unknown>), sanitizationVersion: null };
  }
  return value;
}

function validateRecord(value: unknown): asserts value is SpoolRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_SPOOL_RECORD");
  }
  const record = value as Record<string, unknown>;
  const fence = record.fence;
  if (
    record.version !== 1 ||
    (record.executionKind !== "provider" &&
      record.executionKind !== "acceptance") ||
    !ATTEMPT_PATTERN.test(String(record.attemptId ?? "")) ||
    !ATTEMPT_PATTERN.test(String(record.uploadRequestId ?? "")) ||
    !fence ||
    typeof fence !== "object" ||
    Array.isArray(fence) ||
    !ATTEMPT_PATTERN.test(String((fence as Record<string, unknown>).itemId ?? "")) ||
    !ATTEMPT_PATTERN.test(String((fence as Record<string, unknown>).leaseToken ?? "")) ||
    !Number.isSafeInteger((fence as Record<string, unknown>).leaseGeneration) ||
    ((fence as Record<string, unknown>).leaseGeneration as number) < 1 ||
    !["image/png", "image/jpeg", "image/webp"].includes(String(record.mimeType)) ||
    !Number.isSafeInteger(record.byteSize) ||
    (record.byteSize as number) < 1 ||
    !/^[a-f0-9]{64}$/u.test(String(record.sha256 ?? "")) ||
    (record.sanitizationVersion !== null &&
      (typeof record.sanitizationVersion !== "string" ||
        record.sanitizationVersion.length < 1 ||
        record.sanitizationVersion.length > 100)) ||
    typeof record.promptTemplateVersion !== "string" ||
    record.promptTemplateVersion.length < 1 ||
    record.promptTemplateVersion.length > 100 ||
    (record.providerRequestId !== null &&
      (typeof record.providerRequestId !== "string" ||
        record.providerRequestId.length < 1 ||
        record.providerRequestId.length > 200)) ||
    (record.executionKind === "acceptance" &&
      record.providerRequestId !== null)
  ) {
    throw new Error("INVALID_SPOOL_RECORD");
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
