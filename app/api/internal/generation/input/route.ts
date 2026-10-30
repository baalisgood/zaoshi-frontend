import { errorResponse } from "@/lib/server/api";
import { readAuthenticatedInternalQueueJson } from "@/lib/server/internal-queue-auth";
import { parseInternalInputReadRequest } from "@/lib/server/internal-queue-contract";
import { createInternalQueueExecutionService } from "@/lib/server/internal-queue-route";
import {
  readInternalQueueRuntime,
  requireInternalQueueD1,
} from "@/lib/server/internal-queue-runtime";

export async function POST(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const runtime = readInternalQueueRuntime();
    const d1 = requireInternalQueueD1(runtime);
    const body = await readAuthenticatedInternalQueueJson(
      request,
      d1,
      runtime.auth,
    );
    const input = parseInternalInputReadRequest(body);
    const execution = createInternalQueueExecutionService(runtime, d1);
    const image = await execution.readInput(input.fence, input.ticket);
    const responseBytes = new Uint8Array(image.bytes.byteLength);
    responseBytes.set(image.bytes);
    return new Response(responseBytes.buffer, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": image.mimeType,
        "Content-Length": String(image.byteSize),
        "X-Content-Type-Options": "nosniff",
        "X-Zaoshi-Content-Sha256": image.sha256,
      },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
