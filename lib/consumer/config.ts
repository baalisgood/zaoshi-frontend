import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DomesticAccountSlot, ImageAccountSlot } from "./domestic-executor";
import {
  normalizeInternalControlPlaneBaseUrl,
  resolveInternalControlPlaneTransport,
  type InternalControlPlaneTransport,
} from "@/lib/domain/internal-control-plane";

const IDENTIFIER = /^[A-Za-z0-9:_-]{1,128}$/u;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/u;
const MAX_SECRET_BYTES = 16 * 1024;

export type ConsumerDaemonConfig = {
  publicGenerationEnabled: boolean;
  controlPlaneUrl: string;
  controlPlaneTransport: InternalControlPlaneTransport;
  workerId: string;
  credentials: { keyId: string; secret: string; audience: string };
  spoolRoot: string;
  healthFile: string;
  providerRequestTimeoutMs: number;
  heartbeatIntervalMs: number;
  idleBackoff: { minMs: number; maxMs: number };
  errorBackoff: { minMs: number; maxMs: number };
  reconciliationBackoffMs: number;
  sweepIntervalMs: number;
  busyBurstLimit: number;
  quarantine: { retentionMs: number; maxEntries: number; maxBytes: number };
  slots: {
    seedream: Extract<DomesticAccountSlot, { provider: "seedream" }>;
    qwen: Extract<DomesticAccountSlot, { provider: "qwen" }>;
    openai?: ImageAccountSlot;
    google?: ImageAccountSlot;
  };
};

export async function readConsumerDaemonConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: {
    secretRoot?: string;
    lstat?: typeof lstat;
    readFile?: typeof readFile;
  } = {},
): Promise<ConsumerDaemonConfig> {
  const secretRoot = resolve(dependencies.secretRoot ?? "/run/secrets");
  const secretIo = {
    lstat: dependencies.lstat ?? lstat,
    readFile: dependencies.readFile ?? readFile,
  };
  const controlPlaneTransport = resolveInternalControlPlaneTransport(
    environment.ZAOSHI_CONTROL_PLANE_TRANSPORT,
  );
  const controlPlaneUrl = normalizeInternalControlPlaneBaseUrl(
    environment.ZAOSHI_CONTROL_PLANE_URL,
    controlPlaneTransport,
  );
  const workerId = requireIdentifier(environment.ZAOSHI_CONSUMER_WORKER_ID);
  const keyId = requireIdentifier(environment.ZAOSHI_CONSUMER_KEY_ID);
  const audience = requireIdentifier(environment.ZAOSHI_CONSUMER_AUDIENCE);
  const secret = await readConsumerSecretFile(
    environment.ZAOSHI_CONSUMER_SECRET_FILE,
    "CONSUMER_SECRET",
    32,
    secretRoot,
    secretIo,
  );
  const spoolRoot = requireNarrowAbsolutePath(
    environment.ZAOSHI_SPOOL_ROOT ?? "/var/lib/zaoshi/spool",
    "SPOOL_ROOT",
  );
  const healthFile = requireNarrowAbsolutePath(
    environment.ZAOSHI_HEALTH_FILE ?? "/run/zaoshi/health.json",
    "HEALTH_FILE",
  );
  const seedreamApiKey = await readConsumerSecretFile(
    environment.ZAOSHI_SEEDREAM_API_KEY_FILE,
    "SEEDREAM_API_KEY",
    8,
    secretRoot,
    secretIo,
  );
  const qwenApiKey = await readConsumerSecretFile(
    environment.ZAOSHI_QWEN_API_KEY_FILE,
    "QWEN_API_KEY",
    8,
    secretRoot,
    secretIo,
  );
  const qwenWorkspaceId = environment.ZAOSHI_QWEN_WORKSPACE_ID?.trim() ?? "";
  if (!WORKSPACE_ID.test(qwenWorkspaceId)) {
    throw new Error("INVALID_QWEN_WORKSPACE_ID");
  }

  const overseasSlots: Partial<Record<"openai" | "google", ImageAccountSlot>> = {};
  for (const provider of ["openai", "google"] as const) {
    const prefix = `ZAOSHI_${provider.toUpperCase()}`;
    if (environment[`${prefix}_API_KEY_FILE`]) throw new Error("OVERSEAS_DIRECT_KEY_FORBIDDEN");
    if (environment[`${prefix}_GATEWAY_KEY_FILE`] || environment[`${prefix}_SLOT_ID`]) {
      overseasSlots[provider] = { id: requireIdentifier(environment[`${prefix}_SLOT_ID`]), provider, apiKey: await readConsumerSecretFile(environment[`${prefix}_GATEWAY_KEY_FILE`], `${provider.toUpperCase()}_GATEWAY_KEY`, 8, secretRoot, secretIo) };
    }
  }

  const publicGenerationEnabled = environment.PUBLIC_IMAGE_GENERATION_ENABLED === "1";
  if (publicGenerationEnabled && (environment.BACKEND_PROFILE !== "cn-production" || environment.AUTH_MODE !== "email" || environment.PRIVATE_TEST_EXPIRES_AT !== undefined || environment.OVERSEAS_RELAY_ENABLED !== "1" || !overseasSlots.openai || !overseasSlots.google)) throw new Error("PUBLIC_GENERATION_NOT_CONFIGURED");
  const idleMinMs = integer(environment.ZAOSHI_IDLE_BACKOFF_MIN_MS, 1_000, 250, 30_000);
  const idleMaxMs = integer(environment.ZAOSHI_IDLE_BACKOFF_MAX_MS, 15_000, idleMinMs, 60_000);
  const errorMinMs = integer(environment.ZAOSHI_ERROR_BACKOFF_MIN_MS, 2_000, 500, 60_000);
  const errorMaxMs = integer(environment.ZAOSHI_ERROR_BACKOFF_MAX_MS, 30_000, errorMinMs, 120_000);

  return {
    publicGenerationEnabled,
    controlPlaneUrl,
    controlPlaneTransport,
    workerId,
    credentials: { keyId, secret, audience },
    spoolRoot,
    healthFile,
    providerRequestTimeoutMs: integer(
      environment.ZAOSHI_PROVIDER_TIMEOUT_MS,
      120_000,
      30_000,
      300_000,
    ),
    heartbeatIntervalMs: integer(
      environment.ZAOSHI_HEARTBEAT_INTERVAL_MS,
      8_000,
      1_000,
      60_000,
    ),
    idleBackoff: { minMs: idleMinMs, maxMs: idleMaxMs },
    errorBackoff: { minMs: errorMinMs, maxMs: errorMaxMs },
    reconciliationBackoffMs: integer(
      environment.ZAOSHI_RECONCILIATION_BACKOFF_MS,
      30_000,
      5_000,
      300_000,
    ),
    sweepIntervalMs: integer(
      environment.ZAOSHI_SWEEP_INTERVAL_MS,
      60_000,
      30_000,
      900_000,
    ),
    busyBurstLimit: integer(environment.ZAOSHI_BUSY_BURST_LIMIT, 8, 1, 50),
    quarantine: {
      retentionMs:
        integer(environment.ZAOSHI_QUARANTINE_RETENTION_DAYS, 7, 1, 30) *
        24 *
        60 *
        60 *
        1_000,
      maxEntries: integer(environment.ZAOSHI_QUARANTINE_MAX_ENTRIES, 100, 1, 1_000),
      maxBytes: integer(
        environment.ZAOSHI_QUARANTINE_MAX_BYTES,
        1_073_741_824,
        1_048_576,
        21_474_836_480,
      ),
    },
    slots: {
      ...overseasSlots,
      seedream: {
        id: requireIdentifier(environment.ZAOSHI_SEEDREAM_SLOT_ID),
        provider: "seedream",
        apiKey: seedreamApiKey,
      },
      qwen: {
        id: requireIdentifier(environment.ZAOSHI_QWEN_SLOT_ID),
        provider: "qwen",
        apiKey: qwenApiKey,
        workspaceId: qwenWorkspaceId,
      },
    },
  };
}

export async function readConsumerSecretFile(
  value: string | undefined,
  name: string,
  minimumLength: number,
  secretRoot: string,
  io: { lstat: typeof lstat; readFile: typeof readFile },
): Promise<string> {
  const path = requireSecretPath(value, name, secretRoot);
  const rootStat = await io.lstat(secretRoot).catch(() => {
    throw new Error(`${name}_FILE_UNAVAILABLE`);
  });
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o022) !== 0
  ) {
    throw new Error(`${name}_FILE_UNSAFE`);
  }
  const stat = await inspectSecretHierarchy(path, secretRoot, name, io);
  const effectiveUid = process.geteuid?.();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_SECRET_BYTES ||
    ![0o400, 0o600].includes(stat.mode & 0o777) ||
    !Number.isSafeInteger(effectiveUid) ||
    stat.uid !== effectiveUid
  ) {
    throw new Error(`${name}_FILE_UNSAFE`);
  }
  const secret = (await io.readFile(path, "utf8")).trim();
  if (
    secret.length < minimumLength ||
    secret.length > MAX_SECRET_BYTES ||
    /[\r\n\0]/u.test(secret)
  ) {
    throw new Error(`${name}_INVALID`);
  }
  return secret;
}

async function inspectSecretHierarchy(
  path: string,
  secretRoot: string,
  name: string,
  io: { lstat: typeof lstat },
) {
  const nested = relative(secretRoot, path);
  if (!nested || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error(`${name}_FILE_OUTSIDE_SECRET_ROOT`);
  }
  const parts = nested.split(sep);
  let current = secretRoot;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await io.lstat(current).catch(() => {
      throw new Error(`${name}_FILE_UNAVAILABLE`);
    });
    if (stat.isSymbolicLink()) throw new Error(`${name}_FILE_UNSAFE`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) {
        throw new Error(`${name}_FILE_UNSAFE`);
      }
    } else {
      return stat;
    }
  }
  throw new Error(`${name}_FILE_UNAVAILABLE`);
}

function requireSecretPath(
  value: string | undefined,
  name: string,
  secretRoot: string,
): string {
  if (!value || !isAbsolute(value)) throw new Error(`${name}_FILE_REQUIRED`);
  const path = resolve(value);
  if (!path.startsWith(`${secretRoot}/`)) {
    throw new Error(`${name}_FILE_OUTSIDE_SECRET_ROOT`);
  }
  return path;
}

function requireIdentifier(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!IDENTIFIER.test(normalized)) throw new Error("INVALID_CONSUMER_IDENTIFIER");
  return normalized;
}

function requireNarrowAbsolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name}_MUST_BE_ABSOLUTE`);
  const path = resolve(value);
  if (["/", "/tmp", "/var", "/var/lib", "/run"].includes(path)) {
    throw new Error(`${name}_TOO_BROAD`);
  }
  return path;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]+$/u.test(value)) throw new Error("INVALID_CONSUMER_NUMBER");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("INVALID_CONSUMER_NUMBER");
  }
  return parsed;
}
