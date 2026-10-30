import { ensureDatabase, getD1Binding } from "@/db";
import { ApiError, errorResponse } from "@/lib/server/api";
import { assertSameOriginMutation } from "@/lib/server/runtime-policy";
import { readWechatAuthConfig, validateWechatAuthConfig, wechatAuthFailureResponse } from "@/lib/server/wechat-auth-config";
import { startWechatLogin } from "@/lib/server/wechat-auth";
export async function POST(request: Request): Promise<Response> {
 try {
  assertSameOriginMutation(request);
  const config=readWechatAuthConfig();if(!validateWechatAuthConfig(config))return wechatAuthFailureResponse(config);
  await ensureDatabase();const d1=getD1Binding();if(!d1)throw new ApiError(503,"AUTH_STORAGE_UNAVAILABLE","登录服务暂时不可用。");
  return await startWechatLogin(request,config,d1,"bind");
 } catch(error){return errorResponse(error,crypto.randomUUID());}
}
