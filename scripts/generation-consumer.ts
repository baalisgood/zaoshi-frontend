import { readConsumerDaemonConfig } from "@/lib/consumer/config";
import { HttpConsumerControlPlane } from "@/lib/consumer/control-plane-client";
import { runConsumerPool } from "@/lib/consumer/pool";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createSub2ApiTransport } from "@/lib/consumer/sub2api-fetch";
import { createDomesticGenerationExecutor } from "@/lib/consumer/domestic-executor";
import {
  consumerHealthcheck,
  FileConsumerHealthReporter,
} from "@/lib/consumer/health";
import { FileSystemConsumerSpool } from "@/lib/consumer/spool";
import { nodeImageSanitizer } from "@/lib/platform/node-image-sanitizer";

if (process.argv.includes("--healthcheck")) {
  const healthy = await consumerHealthcheck(
    process.env.ZAOSHI_HEALTH_FILE ?? "/run/zaoshi/health.json",
  );
  process.exitCode = healthy ? 0 : 1;
} else {
  await main();
}

async function main(): Promise<void> {
  try {
    const config = await readConsumerDaemonConfig();
    const privateTestExpiresAt = process.env.PRIVATE_TEST_EXPIRES_AT === undefined ? undefined : Number(process.env.PRIVATE_TEST_EXPIRES_AT);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const control = new HttpConsumerControlPlane(
        config.controlPlaneUrl,
        config.credentials,
        globalThis.fetch,
        config.controlPlaneTransport,
        "provider",
      );
      const slotCount = process.env.BACKEND_PROFILE === "cn-production" && process.env.AUTH_MODE === "email" ? 3 : 1;
      const spools = Array.from({length: slotCount}, (_, index) => new FileSystemConsumerSpool(index === 0 ? config.spoolRoot : join(config.spoolRoot, `.worker-${index}`)));
      // Validate the original root before touching its children; never share recovery directories.
      for (const spool of spools) await spool.list();
      await runConsumerPool(spools.map((spool,index) => ({
        workerId: index === 0 ? config.workerId : `pool_${createHash("sha256").update(`${config.workerId}:${index}`).digest("hex")}`,
        control,
        executor: createDomesticGenerationExecutor({
          slots: config.slots,
          fetch: globalThis.fetch,
          overseasTransport: createSub2ApiTransport({ requestTimeoutMs: config.providerRequestTimeoutMs, privateTestExpiresAt, publicGenerationEnabled: config.publicGenerationEnabled }),
          sanitizer: nodeImageSanitizer,
          providerRequestTimeoutMs: config.providerRequestTimeoutMs,
          privateTestExpiresAt,
          publicGenerationEnabled: config.publicGenerationEnabled,
        }),
        spool,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        idleBackoff: config.idleBackoff,
        errorBackoff: config.errorBackoff,
        reconciliationBackoffMs: config.reconciliationBackoffMs,
        sweepIntervalMs: config.sweepIntervalMs,
        busyBurstLimit: config.busyBurstLimit,
        quarantine: config.quarantine,
      })), new FileConsumerHealthReporter(config.healthFile), controller.signal);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } catch (error) {
    process.stderr.write(`${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  }
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[A-Z0-9_]{1,100}$/u.test(error.message)
  ) {
    return error.message;
  }
  return "CONSUMER_START_FAILED";
}
