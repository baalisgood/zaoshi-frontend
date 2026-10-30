import { parseInternalTransitionInput } from "@/lib/server/internal-queue-contract";
import { handleInternalQueueRequest } from "@/lib/server/internal-queue-route";

export async function POST(request: Request): Promise<Response> {
  return handleInternalQueueRequest(
    request,
    parseInternalTransitionInput,
    (service, input) => service.transition(input),
  );
}
