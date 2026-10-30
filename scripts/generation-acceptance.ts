import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createAcceptanceGenerationExecutor } from "@/lib/acceptance/fixture";
import {
  createAcceptanceFaultHarness,
  isRecoverableAcceptanceScenario,
} from "@/lib/acceptance/faults";
import {
  acceptanceRunIdentity,
  inspectAcceptanceRun,
  seedAcceptanceRun,
} from "@/lib/acceptance/fixture-store";
import { readConsumerSecretFile } from "@/lib/consumer/config";
import { HttpConsumerControlPlane } from "@/lib/consumer/control-plane-client";
import { runOne } from "@/lib/consumer/run-one";
import { FileSystemConsumerSpool } from "@/lib/consumer/spool";
import { acceptanceScenarioFromRunId } from "@/lib/domain/acceptance-fixture";
import {
  normalizeInternalControlPlaneBaseUrl,
  resolveInternalControlPlaneTransport,
} from "@/lib/domain/internal-control-plane";
import { openNodeD1Database } from "@/lib/platform/node-d1";
import { NodeObjectBucket } from "@/lib/platform/node-object-store";

const command = process.argv[2];
const runId = process.argv[3] ?? "";

try {
  const identity = acceptanceRunIdentity(runId);
  const scenario = acceptanceScenarioFromRunId(runId);
  if (command === "seed") {
    const storage = storageConfig();
    const d1 = openNodeD1Database(storage);
    const seeded = await seedAcceptanceRun({
      d1,
      bucket: new NodeObjectBucket(storage.objectRoot),
      runId,
      scenario,
    });
    writeResult({
      command,
      runId: seeded.runId,
      jobId: seeded.jobId,
      itemId: seeded.itemId,
      fixture: "built-in-320px-png",
    });
  } else if (command === "run" || command === "recover") {
    const config = await probeConfig();
    if (command === "recover" && !isRecoverableAcceptanceScenario(scenario)) {
      throw new Error("ACCEPTANCE_SCENARIO_NOT_RECOVERABLE");
    }
    const baseControl = new HttpConsumerControlPlane(
      config.controlPlaneUrl,
      config.credentials,
      globalThis.fetch,
      config.transport,
      "acceptance",
      identity.itemId,
    );
    const baseSpool = new FileSystemConsumerSpool(config.spoolRoot);
    const harness =
      command === "run"
        ? createAcceptanceFaultHarness({
            scenario,
            control: baseControl,
            spool: baseSpool,
          })
        : { control: baseControl, spool: baseSpool };
    let result;
    try {
      result = await runOne({
        workerId: identity.workerId,
        claimRequestId:
          command === "recover" && scenario !== "claim_ack_loss"
            ? identity.recoveryClaimRequestId
            : identity.claimRequestId,
        control: harness.control,
        executor: createAcceptanceGenerationExecutor(),
        spool: harness.spool,
        heartbeatIntervalMs: 8_000,
        expectedItemId: identity.itemId,
      });
    } catch (error) {
      if (
        command === "run" &&
        scenario === "claim_ack_loss" &&
        error instanceof Error &&
        error.message === "ACCEPTANCE_CLAIM_ACK_LOST"
      ) {
        writeResult({ command, runId, scenario, status: "fault-injected" });
        process.exit(0);
      }
      throw error;
    }
    if (
      command === "recover" &&
      scenario === "claim_ack_loss" &&
      result.status === "idle"
    ) {
      result = await runOne({
        workerId: identity.workerId,
        claimRequestId: identity.recoveryClaimRequestId,
        control: harness.control,
        executor: createAcceptanceGenerationExecutor(),
        spool: harness.spool,
        heartbeatIntervalMs: 8_000,
        expectedItemId: identity.itemId,
      });
    }
    if (command === "recover" || scenario === "happy_path") {
      if (result.status !== "completed") {
        throw new Error("ACCEPTANCE_RUN_INCOMPLETE");
      }
    } else if (
      scenario === "output_ack_loss" ||
      scenario === "spool_recovery" ||
      scenario === "reconciliation"
    ) {
      if (result.status !== "reconciliation-required") {
        throw new Error("ACCEPTANCE_FAULT_NOT_OBSERVED");
      }
    } else {
      throw new Error("ACCEPTANCE_FAULT_NOT_OBSERVED");
    }
    writeResult({
      command,
      runId,
      scenario,
      status:
        command === "run" && scenario !== "happy_path"
          ? "fault-injected"
          : result.status,
      ...(result.status === "completed" ? { resumed: result.resumed } : {}),
    });
  } else if (command === "sweep") {
    if (scenario !== "reconciliation" && scenario !== "claim_ack_loss") {
      throw new Error("ACCEPTANCE_SWEEP_SCENARIO_INVALID");
    }
    const config = await probeConfig();
    const control = new HttpConsumerControlPlane(
      config.controlPlaneUrl,
      config.credentials,
      globalThis.fetch,
      config.transport,
      "acceptance",
      identity.itemId,
    );
    const summary = await control.sweep();
    const expectedCount =
      scenario === "reconciliation"
        ? summary.reconciliationRequired
        : summary.retried;
    if (expectedCount < 1) {
      throw new Error("ACCEPTANCE_LEASE_NOT_EXPIRED");
    }
    writeResult({ command, runId, scenario, status: "swept", summary });
  } else if (command === "inspect") {
    const storage = storageConfig();
    const d1 = openNodeD1Database(storage);
    const inspected = await inspectAcceptanceRun(d1, runId);
    if (inspected.scenario !== scenario) {
      throw new Error("ACCEPTANCE_RUN_CONFLICT");
    }
    writeResult({ command, ...inspected });
  } else {
    throw new Error("ACCEPTANCE_COMMAND_REQUIRED");
  }
} catch (error) {
  process.stderr.write(`${safeErrorCode(error)}\n`);
  process.exitCode = 1;
}

function storageConfig(): {
  databasePath: string;
  migrationsDirectory: string;
  objectRoot: string;
} {
  const databasePath = acceptancePath("ZAOSHI_ACCEPTANCE_SQLITE_PATH");
  const migrationsDirectory = requiredAbsolute("ZAOSHI_MIGRATIONS_DIR");
  const objectRoot = acceptancePath("ZAOSHI_ACCEPTANCE_OBJECT_ROOT");
  return { databasePath, migrationsDirectory, objectRoot };
}

async function probeConfig(): Promise<{
  controlPlaneUrl: string;
  transport: "https" | "private-docker";
  credentials: { keyId: string; secret: string; audience: string };
  spoolRoot: string;
}> {
  const transport = resolveInternalControlPlaneTransport(
    process.env.ZAOSHI_CONTROL_PLANE_TRANSPORT,
  );
  const controlPlaneUrl = normalizeInternalControlPlaneBaseUrl(
    process.env.ZAOSHI_CONTROL_PLANE_URL,
    transport,
  );
  const keyId = identifier("ZAOSHI_ACCEPTANCE_KEY_ID");
  const audience = identifier("ZAOSHI_ACCEPTANCE_AUDIENCE");
  const secret = await readConsumerSecretFile(
    process.env.ZAOSHI_ACCEPTANCE_SECRET_FILE,
    "ACCEPTANCE_SECRET",
    32,
    "/run/secrets",
    { lstat, readFile },
  );
  const spoolRoot = acceptancePath("ZAOSHI_ACCEPTANCE_SPOOL_ROOT");
  return {
    controlPlaneUrl,
    transport,
    credentials: { keyId, secret, audience },
    spoolRoot,
  };
}

function acceptancePath(name: string): string {
  const path = requiredAbsolute(name);
  if (!path.split("/").includes("active-item-test")) {
    throw new Error("ACCEPTANCE_PATH_NOT_ISOLATED");
  }
  return path;
}

function requiredAbsolute(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value || !isAbsolute(value)) throw new Error(`${name}_REQUIRED`);
  const path = resolve(value);
  if (path === "/" || path === "/tmp" || path === "/var/lib") {
    throw new Error(`${name}_UNSAFE`);
  }
  return path;
}

function identifier(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]{1,100}$/u.test(error.message)) {
    return error.message;
  }
  return "ACCEPTANCE_COMMAND_FAILED";
}
