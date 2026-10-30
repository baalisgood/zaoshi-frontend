import { ApiError,errorResponse,jsonResponse } from "@/lib/server/api";
import { isDomesticImageModel } from "@/lib/domain/domestic-image-models";
import { quoteGenerationPrice } from "@/lib/server/generation-pricing";
export function GET(request:Request): Response {
 try {
  const query=new URL(request.url).searchParams; const modelId=query.get("modelId");
  if(!isDomesticImageModel(modelId)) throw new ApiError(400,"INVALID_PUBLIC_MODEL","请选择国内模型。");
  const quote=quoteGenerationPrice({modelId,purpose:"final",requestedResolution:query.get("resolution"),inputImageCount:Number(query.get("inputImageCount")),outputCount:Number(query.get("outputCount")),aspectRatio:query.get("aspectRatio")??"4:3"});
  return jsonResponse({quote},{headers:{"Cache-Control":"public, max-age=60"}});
 }catch(error){return errorResponse(error,crypto.randomUUID());}
}
