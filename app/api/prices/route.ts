import { errorResponse,jsonResponse } from "@/lib/server/api";
import { quoteGenerationPrice } from "@/lib/server/generation-pricing";
import { requirePublicModelOption } from "@/lib/server/public-model-option";
export function GET(request:Request): Response {
 try {
  const q=new URL(request.url).searchParams;
  const tuple=requirePublicModelOption({optionId:q.get("optionId"),modelId:q.get("modelId"),resolution:q.get("resolution"),quality:q.get("quality")});
  const quote=quoteGenerationPrice({optionId:q.get("optionId"),modelId:tuple.model,purpose:q.get("purpose")??"final",requestedResolution:tuple.resolution,quality:tuple.quality,inputImageCount:Number(q.get("inputImageCount")),outputCount:Number(q.get("outputCount")),aspectRatio:q.get("aspectRatio")??"4:3"},{production:true});
  return jsonResponse({quote},{headers:{"Cache-Control":"public, max-age=60"}});
 }catch(error){return errorResponse(error,crypto.randomUUID());}
}
