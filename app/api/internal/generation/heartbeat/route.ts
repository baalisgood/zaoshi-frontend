import { parseInternalHeartbeatInput } from "@/lib/server/internal-queue-contract";
import { handleInternalQueueRequest } from "@/lib/server/internal-queue-route";

export async function POST(request: Request): Promise<Response> {
  return handleInternalQueueRequest(
    request,
    parseInternalHeartbeatInput,
    (service, input) => service.heartbeat(input.fence),
  );
}
