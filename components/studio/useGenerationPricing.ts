"use client";

import { useSession } from "@/components/site/session";

import { useEffect, useState } from "react";
import { quoteFinalizedGeneration, quoteGeneration, type GenerationPriceQuote } from "@/components/site/api";
import type { ImageModel } from "@/lib/domain/image-models";

export function useGenerationPricing(input: { optionId?: string; modelId: ImageModel; resolution: string; inputImageCount: number; outputCount: number; quality?: string; aspectRatio: string }) {
  const session = useSession();
  const { optionId, modelId, resolution, inputImageCount, outputCount, quality, aspectRatio } = input;
  const quoteKey = `${optionId ?? ""}:${modelId}:${resolution}:${inputImageCount}:${outputCount}:${quality ?? "auto"}:${aspectRatio}`;
  const [state, setState] = useState<{ key?: string; final?: GenerationPriceQuote; error?: string }>({});
  useEffect(() => {
    if (!session) return;
    if (!optionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      quoteGeneration({ optionId, modelId, resolution, inputImageCount, outputCount, quality, aspectRatio, purpose: "final" }, controller.signal, session.privateTest)
        .then((final) => { if (!controller.signal.aborted) setState({ key: quoteKey, final }); }).catch((error) => {
        if (!controller.signal.aborted) setState({ key: quoteKey, error: error instanceof Error ? error.message : "当前无法确认积分价格。" });
      });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [session, optionId, aspectRatio, inputImageCount, modelId, outputCount, quoteKey, resolution, quality]);
  const current = state.key === quoteKey ? state : {};
  const insufficient = !session?.privateTest && Boolean(current.final && session?.credits && session.credits.available < current.final.totalCredits);
  return { ...current, insufficient };
}

export function useFinalizeGenerationPricing(previewId: string | undefined, resolution: string, outputCount: number, quality?: string, optionId?: string, providerPreference?: string) {
  const quoteKey = previewId ? `${optionId ?? ""}:${providerPreference ?? ""}:${previewId}:${resolution}:${outputCount}:${quality ?? "auto"}` : undefined;
  const [state, setState] = useState<{ key?: string; quote?: GenerationPriceQuote; error?: string }>({});
  useEffect(() => {
    if (!previewId || !quoteKey || !optionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      quoteFinalizedGeneration(previewId, { optionId, providerPreference, resolution, outputCount, quality }, controller.signal)
        .then((quote) => { if (!controller.signal.aborted) setState({ key: quoteKey, quote }); })
        .catch((error) => { if (!controller.signal.aborted) setState({ key: quoteKey, error: error instanceof Error ? error.message : "当前无法确认高清成品积分价格。" }); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [optionId, providerPreference, outputCount, previewId, quoteKey, resolution, quality]);
  return state.key === quoteKey ? state : {};
}
