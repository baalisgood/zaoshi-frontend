import { D1GenerationQueue } from "./generation-queue";
import { errorResponse, jsonResponse } from "./api";
import { readAuthenticatedInternalQueueJson } from "./internal-queue-auth";
import {
  readInternalQueueRuntime,
  requireInternalQueueD1,
  type InternalQueueRuntime,
} from "./internal-queue-runtime";
import { InternalQueueService } from "./internal-queue-service";
import { createInternalQueueExecutionService } from "./internal-queue-execution";

export { createInternalQueueExecutionService } from "./internal-queue-execution";

export async function handleInternalQueueRequest<T>(
  request: Request,
  parse: (body: Record<string, unknown>) => T,
  execute: (
    service: InternalQueueService,
    input: T,
    context: { runtime: InternalQueueRuntime; d1: D1Database },
  ) => Promise<Record<string, unknown> | null>,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const runtime = readInternalQueueRuntime();
    const d1 = requireInternalQueueD1(runtime);
    const body = await readAuthenticatedInternalQueueJson(
      request,
      d1,
      runtime.auth,
    );
    const input = parse(body);
    const execution =
      runtime.r2 && runtime.ticket
        ? createInternalQueueExecutionService(runtime, d1)
        : undefined;
    const service = new InternalQueueService(
      new D1GenerationQueue(d1),
      runtime,
      execution,
      runtime.privateTest ? { d1, config: runtime.privateTest } : null,
    );
    const result = await execute(service, input, { runtime, d1 });
    if (result === null) {
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
