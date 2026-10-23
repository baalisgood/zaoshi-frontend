"use client";

import { useSession } from "@/components/site/session";
import { isDomesticImageModel } from "@/lib/domain/domestic-image-models";
import { useEffect, useState } from "react";
import { quoteFinalizedGeneration, quoteGeneration, type GenerationPriceQuote } from "@/components/site/api";
import type { ImageModel } from "@/lib/domain/image-models";

export function useGenerationPricing(input: { modelId: ImageModel; resolution: string; inputImageCount: number; outputCount: number; quality?: string; aspectRatio: string }) {
  const session = useSession();
  const { modelId, resolution, inputImageCount, outputCount, quality, aspectRatio } = input;
  const quoteKey = `${modelId}:${resolution}:${inputImageCount}:${outputCount}:${quality ?? "auto"}:${aspectRatio}`;
  const [state, setState] = useState<{ key?: string; final?: GenerationPriceQuote; error?: string }>({});
  useEffect(() => {
    if (!session) return;
    if (!session.privateTest && !isDomesticImageModel(modelId)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      quoteGeneration({ modelId, resolution, inputImageCount, outputCount, quality, aspectRatio, purpose: "final" }, controller.signal)
        .then((final) => setState({ key: quoteKey, final })).catch((error) => {
        if (!controller.signal.aborted) setState({ key: quoteKey, error: error instanceof Error ? error.message : "当前无法确认积分价格。" });
      });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [session, aspectRatio, inputImageCount, modelId, outputCount, quoteKey, resolution, quality]);
  const current = state.key === quoteKey ? state : {};
  const insufficient = !session?.privateTest && Boolean(current.final && session?.credits && session.credits.available < current.final.totalCredits);
  return { ...current, insufficient };
}

export function useFinalizeGenerationPricing(previewId: string | undefined, resolution: string, outputCount: number, quality?: string) {
  const quoteKey = previewId ? `${previewId}:${resolution}:${outputCount}:${quality ?? "auto"}` : undefined;
  const [state, setState] = useState<{ key?: string; quote?: GenerationPriceQuote; error?: string }>({});
  useEffect(() => {
    if (!previewId || !quoteKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      quoteFinalizedGeneration(previewId, { resolution, outputCount, quality }, controller.signal)
        .then((quote) => setState({ key: quoteKey, quote }))
        .catch((error) => { if (!controller.signal.aborted) setState({ key: quoteKey, error: error instanceof Error ? error.message : "当前无法确认高清成品积分价格。" }); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [outputCount, previewId, quoteKey, resolution, quality]);
  return state.key === quoteKey ? state : {};
}
