import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type ConsumerHealthState =
  | "starting"
  | "ready"
  | "degraded"
  | "draining"
  | "stopped";

export type ConsumerHealthSnapshot = {
  version: 1;
  state: ConsumerHealthState;
  startedAt: string;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  counters: {
    completed: number;
    safeFailures: number;
    reconciliationRequired: number;
    controlPlaneFailures: number;
    sweeps: number;
    quarantineRemoved: number;
  };
};

export type ConsumerHealthRead = {
  status: "ready" | "degraded" | "stale" | "unavailable";
  snapshot: ConsumerHealthSnapshot | null;
};

export interface ConsumerHealthReporter {
  write(snapshot: ConsumerHealthSnapshot): Promise<void>;
}

export class FileConsumerHealthReporter implements ConsumerHealthReporter {
  private readonly path: string;

  constructor(value: string) {
    if (!isAbsolute(value)) throw new Error("HEALTH_PATH_MUST_BE_ABSOLUTE");
    this.path = resolve(value);
  }

  async write(snapshot: ConsumerHealthSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await lstat(parent);
    if (!safeDirectory(stat)) {
      throw new Error("UNSAFE_HEALTH_DIRECTORY");
    }
    const temporary = join(
      parent,
      `.${basename(this.path)}.${crypto.randomUUID()}.part`,
    );
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(snapshot));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export async function consumerHealthcheck(
  value: string,
  options: { nowMs?: number; maxAgeMs?: number } = {},
): Promise<boolean> {
  return (await readConsumerHealth(value, options)).status === "ready";
}

export async function readConsumerHealth(
  value: string,
  options: { nowMs?: number; maxAgeMs?: number } = {},
): Promise<ConsumerHealthRead> {
  if (!isAbsolute(value)) return { status: "unavailable", snapshot: null };
  try {
    const path = resolve(value);
    const parent = await lstat(dirname(path));
    if (!safeDirectory(parent)) {
      return { status: "unavailable", snapshot: null };
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let parsed: unknown;
    try {
      const stat = await handle.stat();
      const uid = currentUid();
      if (!stat.isFile() || uid === null || Number(stat.uid) !== uid || (Number(stat.mode) & 0o077) !== 0 || Number(stat.size) > 16 * 1024) {
        return { status: "unavailable", snapshot: null };
      }
      const body = Buffer.allocUnsafe(16 * 1024 + 1);
      const { bytesRead } = await handle.read(body, 0, body.length, 0);
      if (bytesRead > 16 * 1024) return { status: "unavailable", snapshot: null };
      parsed = JSON.parse(body.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
    validateSnapshot(parsed);
    const updatedAt = Date.parse(parsed.updatedAt);
    const maxAgeMs = options.maxAgeMs ?? 120_000;
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(updatedAt) || nowMs < updatedAt || nowMs - updatedAt > maxAgeMs) {
      return { status: "stale", snapshot: parsed };
    }
    return { status: parsed.state === "ready" ? "ready" : "degraded", snapshot: parsed };
  } catch {
    return { status: "unavailable", snapshot: null };
  }
}

function safeDirectory(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  const uid = currentUid();
  return stat.isDirectory() && !stat.isSymbolicLink() && uid !== null && Number(stat.uid) === uid && (Number(stat.mode) & 0o022) === 0;
}

function currentUid(): number | null {
  return typeof process.geteuid === "function" ? process.geteuid() : null;
}

function validateSnapshot(value: unknown): asserts value is ConsumerHealthSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_HEALTH_SNAPSHOT");
  }
  const snapshot = value as Record<string, unknown>;
  const counters = snapshot.counters;
  const snapshotKeys = [
    "version",
    "state",
    "startedAt",
    "updatedAt",
    "lastSuccessAt",
    "lastErrorCode",
    "counters",
  ];
  if (
    Object.keys(snapshot).length !== snapshotKeys.length ||
    snapshotKeys.some((key) => !(key in snapshot)) ||
    snapshot.version !== 1 ||
    !["starting", "ready", "degraded", "draining", "stopped"].includes(
      String(snapshot.state),
    ) ||
    !validIsoDate(snapshot.startedAt) ||
    !validIsoDate(snapshot.updatedAt) ||
    (snapshot.lastSuccessAt !== null && !validIsoDate(snapshot.lastSuccessAt)) ||
    (snapshot.lastErrorCode !== null &&
      (typeof snapshot.lastErrorCode !== "string" ||
        !/^[A-Z0-9_]{1,100}$/u.test(snapshot.lastErrorCode))) ||
    !counters ||
    typeof counters !== "object" ||
    Array.isArray(counters)
  ) {
    throw new Error("INVALID_HEALTH_SNAPSHOT");
  }
  const values = counters as Record<string, unknown>;
  const keys = [
    "completed",
    "safeFailures",
    "reconciliationRequired",
    "controlPlaneFailures",
    "sweeps",
    "quarantineRemoved",
  ];
  if (
    Object.keys(values).length !== keys.length ||
    keys.some(
      (key) =>
        !Number.isSafeInteger(values[key]) || (values[key] as number) < 0,
    )
  ) {
    throw new Error("INVALID_HEALTH_SNAPSHOT");
  }
}

function validIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}
