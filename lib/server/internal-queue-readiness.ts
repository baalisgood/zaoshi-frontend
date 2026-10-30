import { ApiError } from "./api";
import type { InternalQueueTicketConfig } from "./internal-queue-ticket";

export function requireInternalQueueClaimReady(runtime: {
  auth: { enabled: boolean };
  r2: R2Bucket | null;
  ticket: InternalQueueTicketConfig | null;
}): void {
  if (!runtime.auth.enabled) {
    throw new ApiError(404, "NOT_FOUND", "没有找到这个接口。");
  }
  if (!runtime.r2) {
    throw new ApiError(
      503,
      "QUEUE_REQUIRES_R2",
      "内部持久任务队列需要 R2。",
    );
  }
  if (!runtime.ticket) {
    throw new ApiError(
      503,
      "INTERNAL_QUEUE_TICKET_MISCONFIGURED",
      "内部任务票据尚未配置。",
    );
  }
}
