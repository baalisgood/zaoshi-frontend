import type { ImageModel, ImageQuality, ImageResolution } from "./image-models";

// The option is UI identity; jobs and work persist the resolved actual tuple.
export const publicModelOptions = [
  { id: "sunburst-medium-2k", label: "GPT Image 2.5 Sunburst · Medium · 2K", resolutions: ["2K"] },
  { id: "flare-low-2k", label: "GPT Image 2.5 Flare · Low · 2K", resolutions: ["2K"] },
  { id: "flare-low-flex", label: "GPT Image 2.5 Flare · Low · 2K / 4K", resolutions: ["2K", "4K"] },
  { id: "gemini-flash", label: "Gemini 3.1 Flash Image · 1K / 2K", resolutions: ["1K", "2K"] },
  { id: "gemini-lite-flash-a", label: "Gemini 3.1 Flash Lite Image 1K / Flash Image 2K · 方案 A", resolutions: ["1K", "2K"] },
  { id: "gemini-lite-flash-b", label: "Gemini 3.1 Flash Lite Image 1K / Flash Image 2K · 方案 B", resolutions: ["1K", "2K"] },
] as const;
export type PublicModelOptionId = typeof publicModelOptions[number]["id"];
export function getPublicModelOption(id: unknown) { return publicModelOptions.find(option => option.id === id); }
export function resolvePublicModelOption(id: unknown, resolution: unknown): { model: ImageModel; quality: ImageQuality; resolution: ImageResolution } | undefined {
  const option = getPublicModelOption(id);
  if (!option || !(option.resolutions as readonly unknown[]).includes(resolution)) return undefined;
  return { model: option.id.startsWith("sunburst") ? "gpt-image-2.5-sunburst" : option.id.startsWith("flare") ? "gpt-image-2.5-flare" : option.id === "gemini-flash" || resolution === "2K" ? "gemini-3.1-flash-image" : "gemini-3.1-flash-lite-image", quality: option.id.startsWith("sunburst") ? "medium" : option.id.startsWith("flare") ? "low" : "auto", resolution: resolution as ImageResolution };
}
export function publicOptionForTuple(model: unknown, quality: unknown, resolution: unknown) {
  return publicModelOptions.find(option => { const tuple = resolvePublicModelOption(option.id, resolution); return tuple !== undefined && tuple.model === model && tuple.quality === quality; });
}
