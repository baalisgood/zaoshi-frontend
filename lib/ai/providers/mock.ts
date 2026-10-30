import { PROMPT_TEMPLATE_VERSION } from "../prompt";
import type {
  GenerateInteriorImagesRequest,
  GenerateInteriorImagesResult,
} from "../types";
import { AiServiceError } from "../types";

export const MOCK_PROVIDER_MODEL = "interior-mock-v2-source-placeholder";

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `mock_${crypto.randomUUID()}`;
  }
  return `mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export async function generateMockInteriorImages(
  request: GenerateInteriorImagesRequest,
): Promise<GenerateInteriorImagesResult> {
  if (!request.sourceImage) throw new AiServiceError({ code: "INVALID_INPUT", message: "Mock provider requires a source image", userMessage: "当前演示模型不支持纯文字生图。", provider: "mock" });
  const sourceImage = request.sourceImage;
  const requestId = createRequestId();
  const outputs = Array.from({ length: request.outputCount }, () => ({
    // Deliberately return the uploaded room as a useful local placeholder. This
    // is never presented as an AI-generated result because metadata.mock is true.
    bytes: sourceImage.bytes.slice(),
    mimeType: sourceImage.mimeType,
    provider: "mock" as const,
    model: MOCK_PROVIDER_MODEL,
    requestId,
    metadata: {
      mock: true,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
      stylePresetId: request.style.presetId,
      placeholder: "source-image-copy",
      workflowType: request.workflowType,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      quality: request.quality,
      controlKinds: request.controlImages?.map((control) => control.kind).join(",") ?? "",
    },
  }));

  return {
    outputs,
    provider: "mock",
    model: MOCK_PROVIDER_MODEL,
    requestId,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
  };
}
