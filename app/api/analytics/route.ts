import { ensureDatabase, getD1Binding } from "@/db";
import { errorResponse, jsonResponse } from "@/lib/server/api";
import { recordAnalyticsEvent } from "@/lib/server/analytics";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    assertSameOriginMutation(request);
    await ensureDatabase();
    const d1 = getD1Binding();
    if (!d1) return jsonResponse({ accepted: false });
    const result = await recordAnalyticsEvent(request, d1);
    const response = jsonResponse({ accepted: result.accepted }, { status: result.accepted ? 201 : 200 });
    if (result.setCookie) response.headers.append("Set-Cookie", result.setCookie);
    return response;
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
