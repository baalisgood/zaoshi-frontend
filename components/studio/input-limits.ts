import { imageModelCapabilities, type ImageModel } from "@/lib/domain/image-models";
import type { UploadedImage } from "@/components/studio/StudioFields";

export type InputLimitSummary = { count: number; max: number; allowed: boolean; bytes: number };

export function countGenerationInputs(input: {
  source?: UploadedImage;
  styleReference?: UploadedImage;
  additionalReferences?: (UploadedImage | undefined)[];
  depth?: UploadedImage;
  normal?: UploadedImage;
  useDepth?: boolean;
  useNormal?: boolean;
}): number {
  return (input.source ? 1 : 0) + (input.styleReference ? 1 : 0) + (input.additionalReferences ?? []).filter(Boolean).length + (input.useDepth && input.depth ? 1 : 0) + (input.useNormal && input.normal ? 1 : 0);
}

export function summarizeGenerationInputs(model: ImageModel, input: Omit<Parameters<typeof countGenerationInputs>[0], never>): InputLimitSummary {
  const count = countGenerationInputs(input);
  const max = imageModelCapabilities[model].maxInputImages;
  const images = [input.source, input.styleReference, ...(input.additionalReferences ?? []), ...(input.useDepth ? [input.depth] : []), ...(input.useNormal ? [input.normal] : [])];
  const bytes = images.reduce<number>((total, image) => total + (image?.byteSize ?? 0), 0);
  return { count, max, allowed: count <= max && bytes <= imageModelCapabilities[model].maxTotalImageBytes && images.every((image) => !image || imageFitsModel(model, image)), bytes };
}

export function imageFitsModel(model: ImageModel, image: Pick<UploadedImage, "byteSize" | "width" | "height">): boolean {
  const capability = imageModelCapabilities[model];
  const dimensions = capability.inputDimensions;
  const width = image.width;
  const height = image.height;
  return (image.byteSize ?? 0) <= capability.maxImageBytes && (!width || !height || !dimensions ||
    (!(dimensions.minSide && Math.min(width, height) < dimensions.minSide) &&
      !(dimensions.maxSide && Math.max(width, height) > dimensions.maxSide) &&
      !(dimensions.maxPixels && width * height > dimensions.maxPixels) &&
      !(dimensions.minRatio && width / height < dimensions.minRatio) &&
      !(dimensions.maxRatio && width / height > dimensions.maxRatio)));
}

/** Keeps simultaneous empty-slot reads from claiming the same remaining model input. */
export function createUploadAdmission() {
  const pending = new Set<string>();
  const pendingBytes = new Map<string, number>();
  let current = { max: 0, maxBytes: 0, count: 0, reserved: 0, bytes: 0, blocked: false, sourceClearBytes: 0, sourceClearCount: 0 };
  const totalBytes = () => current.bytes + [...pendingBytes.values()].reduce((sum, value) => sum + value, 0);
  const available = (occupied: boolean, reserved: boolean, source: boolean) =>
    (source ? current.count + current.reserved + pending.size - current.sourceClearCount <= current.max : (!current.blocked || occupied || reserved) && (current.count + current.reserved + pending.size <= current.max &&
      (occupied || reserved || current.count + current.reserved + pending.size < current.max)));
  return {
    update(model: ImageModel, count: number, reserved: number, bytes: number, blocked = false, sourceClearBytes = 0, sourceClearCount = 0) { current = { max: imageModelCapabilities[model].maxInputImages, maxBytes: imageModelCapabilities[model].maxTotalImageBytes, count, reserved, bytes, blocked, sourceClearBytes, sourceClearCount }; },
    settle(slot: string) { pending.delete(slot); pendingBytes.delete(slot); },
    canAdd() { return available(false, false, false) && totalBytes() < current.maxBytes; },
    field(slot: string, occupied: boolean, reserved = false, source = false, oldBytes = 0) {
      return {
        disabledReason: available(occupied, reserved, source) && (occupied || totalBytes() - (source ? current.sourceClearBytes : 0) < current.maxBytes) ? undefined : `当前模型输入图已达到上限（${current.max}张、总计${Math.round(current.maxBytes / 1024 / 1024)}MB）；请先移除图片或更换模型。`,
        begin(file: File) { if (!available(occupied, reserved, source) || totalBytes() + Math.max(0, file.size - oldBytes) - (source ? current.sourceClearBytes : 0) > current.maxBytes) return false; if (!occupied && !reserved && !source) pending.add(slot); pendingBytes.set(slot, Math.max(0, file.size - oldBytes)); return true; },
        complete() { return (available(occupied, reserved, source) || (!source && !occupied && pending.has(slot) && current.count + current.reserved + pending.size <= current.max)) && totalBytes() - (source ? current.sourceClearBytes : 0) <= current.maxBytes; },
        finish(success: boolean) { if (!success) { pending.delete(slot); pendingBytes.delete(slot); } },
        settle() { pending.delete(slot); pendingBytes.delete(slot); },
      };
    },
  };
}

export function canSelectControlMode(model: ImageModel, fixedInputCount: number, mode: "none" | "depth" | "depth-normal"): boolean {
  return fixedInputCount + (mode === "depth-normal" ? 2 : mode === "depth" ? 1 : 0) <= imageModelCapabilities[model].maxInputImages;
}
