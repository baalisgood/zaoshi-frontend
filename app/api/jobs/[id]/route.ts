import { attachActorCookie } from "@/lib/server/actor";
import { getRuntimeRequestActor } from "@/lib/server/runtime-actor";
import { ApiError, errorResponse, jsonResponse } from "@/lib/server/api";
import {
  getJob,
  getJobOutputs,
  getStorageMode,
  storageHeaders,
} from "@/lib/server/persistence";
import { serializeJob } from "@/lib/server/serializers";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const actor = await getRuntimeRequestActor(request);

  try {
    const { id } = await context.params;
    const job = await getJob(id, actor.ownerId);
    if (!job) {
      throw new ApiError(404, "JOB_NOT_FOUND", "没有找到这个生成任务。");
    }
    const outputs = await getJobOutputs(job.id, actor.ownerId);
    return attachActorCookie(
      jsonResponse(
        {
          job: serializeJob(job, outputs),
          persistence: getStorageMode(),
        },
        { headers: storageHeaders() },
      ),
      actor,
    );
  } catch (error) {
    return attachActorCookie(errorResponse(error, requestId), actor);
  }
}
