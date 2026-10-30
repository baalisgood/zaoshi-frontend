import { parseInternalSweepInput } from "@/lib/server/internal-queue-contract";
import { handleInternalQueueRequest } from "@/lib/server/internal-queue-route";

export async function POST(request: Request): Promise<Response> {
  return handleInternalQueueRequest(
    request,
    parseInternalSweepInput,
    async (service, input) => ({
      summary: await service.sweep(
        input.executionKind,
        input.executionKind === "acceptance" ? input.targetItemId : undefined,
      ),
    }),
  );
}
