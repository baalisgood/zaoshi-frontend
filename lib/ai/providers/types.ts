import type {
  AiProviderName,
  GenerateInteriorImagesRequest,
  GenerateInteriorImagesResult,
} from "../types";

export interface ProviderGenerationContext {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  prompt: string;
  promptTemplateVersion: string;
  baseUrl?: string;
  model?: string;
  requestTimeoutMs?: number;
}

export interface ImageProviderAdapter {
  readonly name: Exclude<AiProviderName, "mock">;
  readonly model: string;
  generate(
    request: GenerateInteriorImagesRequest,
    context: ProviderGenerationContext,
  ): Promise<GenerateInteriorImagesResult>;
}
