"use client";
import { useCallback, useEffect, useState } from "react";
import { getPublicModelOption, resolvePublicModelOption } from "@/lib/domain/public-model-options";
import type { ImageModel, ImageQuality, ImageResolution } from "@/lib/domain/image-models";
export function usePublicModelOption(model: ImageModel, resolution: ImageResolution, quality: ImageQuality, setModel: (model: ImageModel) => void, setResolution: (resolution: ImageResolution) => void, setQuality: (quality: ImageQuality) => void) {
  const [optionId, setOptionId] = useState<string | undefined>("sunburst-medium-2k");
  const tuple = resolvePublicModelOption(optionId, resolution);
  const apply = useCallback((id: unknown, requested: unknown) => {
    const option = getPublicModelOption(id);
    if (!option) { setOptionId(undefined); return undefined; }
    const target = resolvePublicModelOption(option.id, requested) ?? resolvePublicModelOption(option.id, option.resolutions[0])!;
    setOptionId(option.id); setModel(target.model); setResolution(target.resolution); setQuality(target.quality);
    return target;
  }, [setModel, setQuality, setResolution]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the selected option fixes the actual model and quality for each resolution.
  useEffect(() => { if (optionId) apply(optionId, resolution); }, [apply, optionId, resolution, model, quality]);
  return { optionId, ready: Boolean(tuple && tuple.model === model && tuple.quality === quality), select: (id: string) => apply(id, resolution), restore: (config: Record<string, unknown>) => apply(config.optionId, config.resolution) };
}
