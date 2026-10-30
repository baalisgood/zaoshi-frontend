import { errorResponse, ApiError } from "@/lib/server/api";

export async function GET() {
  return errorResponse(new ApiError(404, "GALLERY_DEVELOPER_CURATED", "灵感库仅由开发者维护。"), crypto.randomUUID());
}
