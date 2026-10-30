import { ApiError, errorResponse } from "@/lib/server/api";

export async function GET() {
  return errorResponse(new ApiError(404, "HUMAN_REVIEW_DISABLED", "造室不提供人工图片审核。"), crypto.randomUUID());
}
