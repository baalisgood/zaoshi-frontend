import { getD1Binding } from "@/db";
import { ApiError } from "./api";
import { D1GenerationQueue } from "./generation-queue";

/** Runtime-only factory. The durable queue deliberately has no memory fallback. */
export function getGenerationQueue(): D1GenerationQueue {
  const d1 = getD1Binding();
  if (!d1) {
    throw new ApiError(
      503,
      "QUEUE_REQUIRES_D1",
      "持久任务队列需要 D1，不能回退到本地内存。",
    );
  }
  return new D1GenerationQueue(d1);
}
