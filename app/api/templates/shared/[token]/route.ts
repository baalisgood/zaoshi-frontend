import { ApiError, errorResponse, jsonResponse } from "@/lib/server/api";
import { getSharedTemplate } from "@/lib/server/templates";
type Ctx = { params: Promise<{ token: string }> };
export async function GET(request: Request, context: Ctx) { try { const {token}=await context.params; const row=await getSharedTemplate(token); if (!row) throw new ApiError(404, "SHARE_NOT_FOUND", "分享模板不存在或已撤销。"); return jsonResponse({template:row}); } catch(error) { return errorResponse(error,crypto.randomUUID()); } }
