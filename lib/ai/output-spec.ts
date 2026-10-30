import type {
  OutputAspectRatio,
  OutputQuality,
  OutputResolution,
} from "./types";

export type OpenAiQuality = Exclude<OutputQuality, "draft" | "standard">;
type ProviderOutputResolution = Exclude<OutputResolution, "0.5K">;

const OPENAI_SIZE_MAP: Record<
  ProviderOutputResolution,
  Record<OutputAspectRatio, `${number}x${number}`>
> = {
  "1K": {
    "1:1": "1024x1024",
    "4:3": "1024x768",
    "3:2": "1152x768",
    "16:9": "1280x720",
    "9:16": "720x1280",
  },
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2048x1536",
    "3:2": "2304x1536",
    "16:9": "2048x1152",
    "9:16": "1152x2048",
  },
  "4K": {
    "1:1": "2880x2880",
    "4:3": "3200x2400",
    "3:2": "3456x2304",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
  },
};

const OPENAI_QUALITY_MAP: Record<OutputQuality, OpenAiQuality> = {
  draft: "low",
  standard: "medium",
  high: "high",
  auto: "auto",
  low: "low",
  medium: "medium",
  xhigh: "xhigh",
  max: "max",
};

export function openAiSize(
  resolution: ProviderOutputResolution,
  aspectRatio: OutputAspectRatio,
): `${number}x${number}` {
  return OPENAI_SIZE_MAP[resolution][aspectRatio];
}

export function openAiQuality(quality: OutputQuality): OpenAiQuality {
  return OPENAI_QUALITY_MAP[quality];
}
