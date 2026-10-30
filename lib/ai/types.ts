import type { ImageModel, StoredImageQuality } from "@/lib/domain/image-models";

export type AiProviderName = "openai" | "google" | "mock" | "seedream" | "qwen" | "hunyuan" | "kling";

export type ProviderPreference = "auto" | AiProviderName | ImageModel;

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface BinaryImage {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  fileName?: string;
}

export interface StyleSelection {
  presetId: string;
  templateVersion?: string;
  customDirection?: string;
}
export type ReferenceRole = "selection" | "style" | "reference" | "furnishing" | "structure" | "material" | "lighting-color" | "composition";
export interface ReferenceImage {
  image: BinaryImage;
  role: ReferenceRole;
}

export type TimeOfDay = "dawn" | "day" | "overcast" | "dusk" | "night";
export type ColorTemperature = "warm" | "neutral" | "cool";

export interface LightingSelection {
  timeOfDay: TimeOfDay;
  lampState: LampState;
  colorTemperatureKelvin: number;
}

export type WorkflowType = "concept" | "advanced" | "floorplan" | "self-service";
export type JobPurpose = "preview" | "final";
export type OutputResolution = "0.5K" | "1K" | "2K" | "4K";
export type OutputAspectRatio = "1:1" | "4:3" | "3:2" | "16:9" | "9:16";
export type OutputQuality = StoredImageQuality;
export type VisualRealism = "conceptual" | "rendered" | "realistic" | "photorealistic";
export type LampState = "on" | "off" | "mixed";

export type AdvancedSettings = {
  version: 1;
  geometryFidelity: "strict" | "balanced";
  cameraPolicy: "locked" | "correct-verticals";
  furnishingDensity: "sparse" | "balanced" | "layered";
  materialExpression: "clean" | "natural" | "tactile";
  lightingContrast: "soft" | "balanced" | "dramatic";
};

export interface ControlImage {
  kind: "depth" | "normal";
  image: BinaryImage;
}

export type RenovationScope =
  | "restyle"
  | "replace-soft-furnishings"
  | "empty-room"
  | "local-edit";

export interface GenerateInteriorImagesRequest {
  sourceImage?: BinaryImage;
  workflowType: WorkflowType;
  purpose?: JobPurpose;
  promotedFromPreview?: boolean;
  resolution: OutputResolution;
  aspectRatio: OutputAspectRatio;
  quality: OutputQuality;
  /** Visual expression is independent from render quality/resolution. */
  visualRealism?: VisualRealism;
  style: StyleSelection;
  lighting: LightingSelection;
  renovationScope: RenovationScope;
  /** Ordered structural controls. Depth must precede normal when both exist. */
  controlImages?: ControlImage[];
  /** Role-bearing references are canonical; bare BinaryImage remains for old adapters. */
  referenceImages?: Array<ReferenceImage | BinaryImage>;
  mask?: BinaryImage;
  editInstruction?: string;
  customPrompt?: string;
  designSchemeId?: string | null;
  outputCount: number;
  providerPreference?: ProviderPreference;
  advancedSettings?: AdvancedSettings;
  /** Semantic room type; omitted by historical jobs. */
  spaceType?: "living-room" | "corridor" | "children-room" | "bedroom" | "dining-room" | "kitchen" | "bathroom" | "study" | "unspecified";
  /** Stable queue item ID; only used to vary style choices between independent renders. */
  variationKey?: string;
}

export interface AiRuntimeEnvironment {
  OPENAI_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  GEMINI_API_KEY?: string;
  VISION_PIPELINE_URL?: string;
  VISION_PIPELINE_API_KEY?: string;
  ARK_API_KEY?: string;
  ARK_BASE_URL?: string;
  ARK_PROMPT_MODEL?: string;
  ARK_IMAGE_MODEL?: string;
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_WORKSPACE_ID?: string;
  TENCENT_TOKENHUB_API_KEY?: string;
  KLING_API_TOKEN?: string;
  PUBLIC_IMAGE_GENERATION_ENABLED?: string;
  GENERATION_INTERNAL_API_ENABLED?: string;
  OVERSEAS_RELAY_ENABLED?: string;
  AUTH_MODE?: string;
  DOMESTIC_AI_CANARY_EMAILS?: string;
  TRUST_PLATFORM_IDENTITY_HEADERS?: "0" | "1";
  BACKEND_PROFILE?: "sites-demo" | "cn-production";
}

export interface GenerateInteriorImagesOptions {
  env?: AiRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Operator-only probes may wait longer than the normal request path. */
  providerRequestTimeoutMs?: number;
}

export interface AiOutputMetadata {
  mock: boolean;
  promptTemplateVersion: string;
  stylePresetId: string;
  [key: string]: string | number | boolean;
}

export interface GeneratedInteriorImage {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  provider: AiProviderName;
  model: string;
  requestId: string;
  metadata: AiOutputMetadata;
}

export interface GenerateInteriorImagesResult {
  outputs: GeneratedInteriorImage[];
  provider: AiProviderName;
  model: string;
  /** Provider-issued identifier only. Missing when the provider omitted it. */
  providerRequestId?: string;
  /** Local correlation identifier; never use this field for billing disputes. */
  requestId: string;
  promptTemplateVersion: string;
}

export type AiErrorCode =
  | "INVALID_INPUT"
  | "STYLE_NOT_FOUND"
  | "STYLE_VERSION_MISMATCH"
  | "MASK_REQUIRED"
  | "MASK_FORMAT_MISMATCH"
  | "MASK_DIMENSIONS_MISMATCH"
  | "MASK_ALPHA_REQUIRED"
  | "IMAGE_TOO_LARGE"
  | "NOT_CONFIGURED"
  | "CONTENT_REJECTED"
  | "RATE_LIMITED"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_QUOTA_EXCEEDED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "NO_IMAGE_OUTPUT"
  | "VISION_PIPELINE_NOT_CONFIGURED"
  | "VISION_PIPELINE_ERROR";

export interface AiServiceErrorOptions {
  code: AiErrorCode;
  message: string;
  userMessage: string;
  retryable?: boolean;
  provider?: AiProviderName | "vision-pipeline";
  /** Provider-issued identifier only; safe for billing reconciliation. */
  providerRequestId?: string;
  /** General correlation identifier; may be locally generated. */
  requestId?: string;
  status?: number;
  providerCode?: string;
  cause?: unknown;
}

export class AiServiceError extends Error {
  readonly code: AiErrorCode;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly provider?: AiProviderName | "vision-pipeline";
  readonly providerRequestId?: string;
  readonly requestId?: string;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(options: AiServiceErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AiServiceError";
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.retryable = options.retryable ?? false;
    this.provider = options.provider;
    this.providerRequestId = options.providerRequestId;
    this.requestId = options.requestId;
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}

export function isAiServiceError(error: unknown): error is AiServiceError {
  return error instanceof AiServiceError;
}

export type VisionArtifactKind = "depth" | "normal";

export interface GenerateVisionArtifactsRequest {
  sourceImage: BinaryImage;
  artifacts: VisionArtifactKind[];
}

export interface VisionArtifact {
  kind: VisionArtifactKind;
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  model?: string;
  confidence?: number;
}

export interface GenerateVisionArtifactsResult {
  requestId: string;
  provider: "vision-pipeline";
  artifacts: VisionArtifact[];
}
