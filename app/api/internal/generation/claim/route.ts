import { parseInternalClaimInput } from "@/lib/server/internal-queue-contract";
import { handleInternalQueueRequest } from "@/lib/server/internal-queue-route";
import { requireInternalQueueClaimReady } from "@/lib/server/internal-queue-readiness";

export async function POST(request: Request): Promise<Response> {
  return handleInternalQueueRequest(
    request,
    parseInternalClaimInput,
    async (service, input, { runtime }) => {
      requireInternalQueueClaimReady(runtime);
      const claim = await service.claim(
        input.workerId,
        input.claimRequestId,
        input.executionKind,
        input.targetItemId,
      );
      return claim ? { claim } : null;
    },
  );
}
