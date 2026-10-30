import { parseInternalWorkRequestInput } from "@/lib/server/internal-queue-contract";
import {
  createInternalQueueExecutionService,
  handleInternalQueueRequest,
} from "@/lib/server/internal-queue-route";

export async function POST(request: Request): Promise<Response> {
  return handleInternalQueueRequest(
    request,
    parseInternalWorkRequestInput,
    async (_service, input, { runtime, d1 }) => {
      const execution = createInternalQueueExecutionService(runtime, d1);
      return { work: await execution.createWork(input.fence) };
    },
  );
}
