import { errorResponse, jsonResponse } from "@/lib/server/api";
import { readAuthenticatedInternalQueueBody } from "@/lib/server/internal-queue-auth";
import { parseInternalOutputUploadHeaders } from "@/lib/server/internal-queue-contract";
import {
  MAX_INTERNAL_OUTPUT_BYTES,
} from "@/lib/server/internal-queue-execution";
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
    const bytes = await readAuthenticatedInternalQueueBody(
      request,
      d1,
      runtime.auth,
      {
        maxBytes: MAX_INTERNAL_OUTPUT_BYTES,
        contentTypes: ["image/png", "image/jpeg", "image/webp"],
        emptyErrorCode: "EMPTY_OUTPUT",
      },
    );
    const { fence, ticket } = parseInternalOutputUploadHeaders(request.headers);
    const execution = createInternalQueueExecutionService(runtime, d1);
    const declaredMimeType = (request.headers.get("content-type") ?? "")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    return jsonResponse({
      output: await execution.uploadOutput(
        fence,
        ticket,
        bytes,
        declaredMimeType,
      ),
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
