import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  generateInteriorImages,
  isAiServiceError,
  type AiRuntimeEnvironment,
  type GenerateInteriorImagesRequest,
} from "../lib/ai/index";
import { resolveAiEnvironment } from "../lib/ai/env";
import { assertGenerationRuntime } from "../lib/server/runtime-policy";

export const SMOKE_MODELS = [
  "doubao-seedream-5-0-pro-260628",
  "doubao-seedream-4-5-251128",
  "qwen-image-3.0-pro",
  "qwen-image-2.0-pro",
] as const;

export type SmokeModel = (typeof SMOKE_MODELS)[number];

const COST_CONFIRMATION = "ONE_IMAGE";
const SMOKE_PROMPT = "现代简约室内空间，布局合理，材质真实，柔和自然日光，垂直线端正，照片级效果图。";

export class SmokeCliError extends Error {
  readonly exitCode = 2;

  constructor(readonly code: string) {
    super(code);
    this.name = "SmokeCliError";
  }
}

export type ParsedSmokeArgs =
  | { help: true }
  | { help: false; model: SmokeModel };

export type SmokeSummary = {
  provider: string;
  model: string;
  requestId: string;
  outputCount: number;
  byteSize: number;
  outputPath: string;
  elapsedMs: number;
};

export function parseSmokeArgs(argv: readonly string[]): ParsedSmokeArgs {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };

  let model: SmokeModel | undefined;
  let live = false;
  let confirmed = false;

  for (const argument of argv) {
    if (argument === "--live") {
      if (live) throw new SmokeCliError("DUPLICATE_LIVE_FLAG");
      live = true;
      continue;
    }
    if (argument === `--confirm-cost=${COST_CONFIRMATION}`) {
      if (confirmed) throw new SmokeCliError("DUPLICATE_COST_CONFIRMATION");
      confirmed = true;
      continue;
    }
    if (argument.startsWith("--") || argument === "-h") {
      throw new SmokeCliError("UNKNOWN_ARGUMENT");
    }
    if (model) throw new SmokeCliError("TOO_MANY_MODELS");
    if (!(SMOKE_MODELS as readonly string[]).includes(argument)) {
      throw new SmokeCliError("MODEL_NOT_ALLOWED");
    }
    model = argument as SmokeModel;
  }

  if (!model) throw new SmokeCliError("MODEL_REQUIRED");
  if (!live) throw new SmokeCliError("LIVE_CONFIRMATION_REQUIRED");
  if (!confirmed) throw new SmokeCliError("COST_CONFIRMATION_REQUIRED");
  return { help: false, model };
}

export function buildSmokeRequest(model: SmokeModel): GenerateInteriorImagesRequest {
  return {
    workflowType: "self-service",
    purpose: "final",
    resolution: model.startsWith("doubao-seedream-") ? "2K" : "1K",
    aspectRatio: "1:1",
    quality: "standard",
    style: { presetId: "self-service" },
    lighting: { timeOfDay: "day", lampState: "mixed", colorTemperatureKelvin: 4000 },
    renovationScope: "restyle",
    customPrompt: SMOKE_PROMPT,
    outputCount: 1,
    providerPreference: model,
  };
}

export async function runDomesticProviderSmoke(options: {
  model: SmokeModel;
  env?: AiRuntimeEnvironment;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  writeOutput?: (path: string, bytes: Uint8Array) => Promise<void>;
  signal?: AbortSignal;
}): Promise<SmokeSummary> {
  const environment = resolveAiEnvironment(options.env);
  assertGenerationRuntime(options.model, environment);

  const startedAt = (options.now ?? Date.now)();
  const signal = options.signal ?? AbortSignal.timeout(120_000);
  const result = await generateInteriorImages(buildSmokeRequest(options.model), {
    env: environment,
    fetch: options.fetch,
    signal,
    providerRequestTimeoutMs: 120_000,
  });
  const output = result.outputs[0];
  if (!output || result.outputs.length !== 1) throw new SmokeCliError("SINGLE_OUTPUT_REQUIRED");

  const finishedAt = (options.now ?? Date.now)();
  const extension = output.mimeType === "image/jpeg" ? "jpg" : output.mimeType === "image/webp" ? "webp" : "png";
  const outputPath = resolve("outputs", "domestic-smoke", `${startedAt}-${result.provider}.${extension}`);
  const writeOutput = options.writeOutput ?? writeSmokeOutput;
  await writeOutput(outputPath, output.bytes);

  return {
    provider: result.provider,
    model: result.model,
    requestId: sanitizeIdentifier(result.requestId),
    outputCount: result.outputs.length,
    byteSize: output.bytes.byteLength,
    outputPath,
    elapsedMs: Math.max(0, finishedAt - startedAt),
  };
}

async function writeSmokeOutput(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(resolve("outputs", "domestic-smoke"), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64);
}

function usage(): string {
  return [
    "一次性国产图片供应商连通测试（会产生一张图片的真实费用）",
    "",
    "用法：",
    "  npm run smoke:domestic -- <model> --live --confirm-cost=ONE_IMAGE",
    "",
    "允许的 model：",
    ...SMOKE_MODELS.map((model) => `  ${model}`),
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    const parsed = parseSmokeArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const summary = await runDomesticProviderSmoke({ model: parsed.model });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const code = error instanceof SmokeCliError
      ? error.code
      : isAiServiceError(error)
        ? error.code
        : "UNEXPECTED_ERROR";
    process.stderr.write(`国产供应商连通测试失败：${code}\n`);
    process.exitCode = error instanceof SmokeCliError ? error.exitCode : 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) void main();
