import type {
  ConsumerControlPlane,
  ConsumerSpool,
  SpoolRecord,
} from "@/lib/consumer/contracts";
import type { AcceptanceScenario } from "@/lib/domain/acceptance-fixture";

export type AcceptanceFaultHarness = {
  control: ConsumerControlPlane;
  spool: ConsumerSpool;
};

/**
 * Fixed acceptance-only fault boundaries. This wrapper cannot alter provider
 * configuration, prompts, URLs, payloads, or timeouts, and must never be used
 * by the provider consumer entry point.
 */
export function createAcceptanceFaultHarness(input: {
  scenario: AcceptanceScenario;
  control: ConsumerControlPlane;
  spool: ConsumerSpool;
}): AcceptanceFaultHarness {
  let claimAckDropped = false;
  let outputAckDropped = false;
  let spoolCrashInjected = false;
  let dispatchCrashInjected = false;

  const control: ConsumerControlPlane = {
    async claim(workerId, claimRequestId) {
      const claim = await input.control.claim(workerId, claimRequestId);
      if (
        input.scenario === "claim_ack_loss" &&
        claim &&
        !claimAckDropped
      ) {
        claimAckDropped = true;
        throw new Error("ACCEPTANCE_CLAIM_ACK_LOST");
      }
      return claim;
    },
    heartbeat: (fence) => input.control.heartbeat(fence),
    async transition(transitionInput) {
      if (
        input.scenario === "spool_recovery" &&
        spoolCrashInjected &&
        transitionInput.event === "MARK_AMBIGUOUS"
      ) {
        throw new Error("ACCEPTANCE_PROCESS_CRASHED");
      }
      const result = await input.control.transition(transitionInput);
      if (
        input.scenario === "reconciliation" &&
        transitionInput.event === "BEGIN_ACCEPTANCE_EXECUTION" &&
        !dispatchCrashInjected
      ) {
        dispatchCrashInjected = true;
        throw new Error("ACCEPTANCE_POST_DISPATCH_CRASH");
      }
      return result;
    },
    work: (fence) => input.control.work(fence),
    input: (fence, ticket) => input.control.input(fence, ticket),
    prepareOutput: (prepareInput) => input.control.prepareOutput(prepareInput),
    async uploadOutput(fence, ticket, mimeType, bytes) {
      const result = await input.control.uploadOutput(
        fence,
        ticket,
        mimeType,
        bytes,
      );
      if (input.scenario === "output_ack_loss" && !outputAckDropped) {
        outputAckDropped = true;
        throw new Error("ACCEPTANCE_OUTPUT_ACK_LOST");
      }
      return result;
    },
  };

  const spool: ConsumerSpool = {
    list: () => input.spool.list(),
    read: (record) => input.spool.read(record),
    async save(record: SpoolRecord, bytes: Uint8Array) {
      await input.spool.save(record, bytes);
      if (input.scenario === "spool_recovery" && !spoolCrashInjected) {
        spoolCrashInjected = true;
        throw new Error("ACCEPTANCE_SPOOL_CRASH");
      }
    },
    remove: (record) => input.spool.remove(record),
    quarantine: (record, reason) => input.spool.quarantine(record, reason),
  };

  return { control, spool };
}

export function isRecoverableAcceptanceScenario(
  scenario: AcceptanceScenario,
): boolean {
  return (
    scenario === "claim_ack_loss" ||
    scenario === "output_ack_loss" ||
    scenario === "spool_recovery"
  );
}
