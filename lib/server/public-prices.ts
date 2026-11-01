import { publicModelOptions, resolvePublicModelOption } from "@/lib/domain/public-model-options";
import { imageModelCapabilities } from "@/lib/domain/image-models";
import { quoteGenerationPrice } from "./generation-pricing";
export function publicPriceCatalog() {
  return publicModelOptions.map(option => ({ optionId: option.id, label: option.label, aspectRatio: "4:3", resolutions: option.resolutions, prices: option.resolutions.map(resolution => {
    const tuple = resolvePublicModelOption(option.id, resolution)!;
    const maxInputs = imageModelCapabilities[tuple.model].maxInputImages;
    return { modelId: tuple.model, resolution, quality: tuple.quality, maxInputs, amounts: Array.from({ length: maxInputs + 1 }, (_, inputImageCount) => quoteGenerationPrice({ optionId: option.id, modelId: tuple.model, quality: tuple.quality, purpose: "final", requestedResolution: resolution, inputImageCount, outputCount: 1, aspectRatio: "4:3" }, { production: true }).amountPerItem) };
  }) }));
}
