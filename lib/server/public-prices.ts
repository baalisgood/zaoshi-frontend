import { domesticImageModelValues, domesticImageModelCapabilities } from "@/lib/domain/domestic-image-models";
import { quoteGenerationPrice } from "./generation-pricing";
export function publicPriceCatalog() {
 return domesticImageModelValues.map(modelId=>({modelId,label:domesticImageModelCapabilities[modelId].label,resolutions:domesticImageModelCapabilities[modelId].supportedResolutions,maxInputs:domesticImageModelCapabilities[modelId].maxInputImages,prices:domesticImageModelCapabilities[modelId].supportedResolutions.map(resolution=>Array.from({length:domesticImageModelCapabilities[modelId].maxInputImages+1},(_,inputImageCount)=>quoteGenerationPrice({modelId,purpose:"final",requestedResolution:resolution,inputImageCount,outputCount:1}).amountPerItem))}));
}
