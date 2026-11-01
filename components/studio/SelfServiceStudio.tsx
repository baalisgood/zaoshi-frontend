"use client";
import { GenerationPriceDetails } from "./StudioFields";

import { useEffect, useState } from "react";
import { GenerationView } from "@/components/studio/GenerationView";
import {
  ImageUploadField,
  ImageModelSelect, OutputCounter,
  Segmented,
  usePrivateTestMode,
  type UploadedImage,
} from "@/components/studio/StudioFields";
import { useGenerationJob } from "@/components/studio/useGenerationJob";
import { PromptComposer } from "@/components/studio/PromptComposer";
import { StudioTaskList } from "@/components/studio/StudioTaskList";
import { useStudioParameterDraft } from "@/components/studio/useStudioParameterDraft";
import { usePublicModelOption } from "./usePublicModelOption";
import { getPublicModelOption, publicModelOptions } from "@/lib/domain/public-model-options";
import { useGenerationPricing } from "@/components/studio/useGenerationPricing";
import { imageModelMaxReferences, imageModelOptions, normalizeKnownImageModel, normalizeImageResolution, normalizeImageQuality, imageQualityLabel, restoreSelfServiceResolution, type ImageModel, type ImageQuality, type ImageResolution } from "@/lib/domain/image-models";
import { createUploadAdmission, summarizeGenerationInputs } from "@/components/studio/input-limits";

function nearestAspectRatio(image?: UploadedImage) {
  if (!image?.width || !image.height) return "4:3";
  const ratio = image.width / image.height;
  const options = [
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:2", 3 / 2],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
  ] as const;
  return options.reduce((best, current) =>
    Math.abs(current[1] - ratio) < Math.abs(best[1] - ratio) ? current : best,
  )[0];
}

export type ReferenceSlot = { key: string; image?: UploadedImage; state: "idle" | "uploading" | "ready" | "error"; restoredEmpty?: boolean; keepEmpty?: boolean };

export function finishReferenceRestore(slots: ReferenceSlot[], key: string, hasImage: boolean): ReferenceSlot[] {
  if (!slots.some((slot) => slot.key === key)) return slots;
  const next = slots.map((slot) => slot.key === key ? { ...slot, restoredEmpty: !hasImage } : slot);
  // Keep image positions stable; only trim confirmed empty trailing slots from an old draft.
  while (next.length > 1) {
    const last = next[next.length - 1];
    if (!last.restoredEmpty || last.keepEmpty || last.image || last.state !== "idle") break;
    next.pop();
  }
  return next;
}

export function SelfServiceStudio() {
  const privateTest = usePrivateTestMode();
  const [provider, setProvider] = useState<ImageModel>("gpt-image-2.5-sunburst");
  const controller = useGenerationJob(privateTest);
  const [referenceSlots, setReferenceSlots] = useState<ReferenceSlot[]>([
    { key: "reference-slot-1", state: "idle" },
  ]);
  const references = referenceSlots.flatMap((slot) => slot.image ? [slot.image] : []);
  const [admission] = useState(() => createUploadAdmission());
  const inputSummary = summarizeGenerationInputs(provider, { additionalReferences: references });
  admission.update(provider, inputSummary.count, 0, inputSummary.bytes, !inputSummary.allowed);
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<ImageQuality>("medium");
  const [resolution, setResolution] = useState<ImageResolution>("2K");
  const modelOption = usePublicModelOption(provider, resolution, quality, setProvider, setResolution, setQuality);
  const optionResolutionChoices = publicModelOptions.find(option => option.id === modelOption.optionId)?.resolutions ?? [];
  const selectedResolutionOptions = (["1K", "2K", "4K"] as const).map(value => ({ value, label: value, disabled: !(optionResolutionChoices as readonly string[]).includes(value) }));
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reconcile unsupported selections after model changes.
  useEffect(() => { setResolution((current) => normalizeImageResolution(provider, current)); setQuality((current) => normalizeImageQuality(provider, current)); }, [provider]);
  const [outputCount, setOutputCount] = useState(1);

  const applyConfig = (config: Record<string, unknown>) => {
    const restoredOption = modelOption.restore(config);
    const nextProvider = restoredOption?.model ?? normalizeKnownImageModel(config.providerPreference) ?? provider;
    setProvider(nextProvider);
    setResolution(restoredOption?.resolution ?? restoreSelfServiceResolution(nextProvider, config));
    setQuality(restoredOption?.quality ?? normalizeImageQuality(nextProvider, config.quality));
    if (typeof config.outputCount === "number" && Number.isInteger(config.outputCount) && config.outputCount >= 1 && config.outputCount <= 4) setOutputCount(config.outputCount);
    if (typeof config.customPrompt === "string") setPrompt(config.customPrompt);
    const referenceCount = Array.isArray(config.referenceHints) ? config.referenceHints.reduce((sum, hint) => hint && typeof hint === "object" && (hint as { role?: unknown }).role === "reference" && Number.isInteger((hint as { count?: unknown }).count) ? sum + Number((hint as { count: number }).count) : sum, 0) : 0;
    if (typeof config.referenceSlotCount === "number" || referenceCount) { const count = typeof config.referenceSlotCount === "number" ? config.referenceSlotCount : referenceCount; setReferenceSlots((current) => Array.from({ length: Math.max(1, Math.min(14, count)) }, (_, index) => current[index] ?? { key: `reference-slot-${index + 1}`, state: "idle" })); }
  };
  useStudioParameterDraft("self-service", { optionId: modelOption.optionId, providerPreference: provider, resolution, quality, outputCount, customPrompt: prompt, referenceSlotCount: referenceSlots.length, referenceHints: references.length ? [{ role: "reference", count: references.length }] : [] }, applyConfig);

  const aspectRatio = nearestAspectRatio(references[0]);
  const maxReferences = imageModelMaxReferences(provider, "final", false);
  const pricing = useGenerationPricing({ optionId: modelOption.ready ? modelOption.optionId : undefined, modelId: provider, resolution, inputImageCount: references.length, outputCount, quality, aspectRatio });
  const canGenerate = Boolean(prompt.trim()) && privateTest !== undefined && inputSummary.allowed &&
    !referenceSlots.some((slot) => slot.state === "uploading" || slot.state === "error") &&
    !controller.submitting;
  async function generate() {
    const quote = pricing.final;
    if (!canGenerate || !quote) return;
    await controller.submit({
      workflowType: "self-service",
      purpose: "final",
      sourceAssetId: null,
      additionalReferences: references.map((image) => ({ assetId: image.id, role: "reference" as const })),
      customPrompt: prompt.trim(),
      optionId: modelOption.optionId, providerPreference: provider,
      outputCount,
      resolution,
      aspectRatio,
      quality,
      billingMode: quote.billingMode, expectedPriceVersion: quote.priceVersion,
      expectedTotalCredits: quote.totalCredits,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  return (
    <div className="page-shell studio-page self-service-page">
      <header className="page-intro">
        <div>
          <span className="section-kicker">SELF-SERVICE STUDIO</span>
          <h1>把创作要求直接交给图像模型</h1>
          <p>可不上传图片，也可以按顺序上传多张参考图，再写下你希望得到的画面。系统仍会补充安全与输出约束，但不会替你套用风格模板。</p>
        </div>
        <span className="page-tag">自由提示词 · 文生图·图生图</span>
      </header>


      <div className="studio-workspace">
        <div className="studio-primary">
          <section className="studio-panel">
            <div className="panel-heading">
              <span>01</span>
              <div>
                <h2>参考图（可选）</h2>
                <p>可不上传图片进行纯文生图，也可按顺序添加最多 {maxReferences} 张参考图。</p>
              </div>
            </div>
            <div className="upload-pair">
              {referenceSlots.map((slot, index) => <ImageUploadField key={slot.key} compact draftKey={`self-service:reference:${index}`} title={`参考图 ${index + 1}`} hint="按添加顺序发送；不上传也可以纯文字生图。" kind="reference" value={slot.image} model={provider} uploadGate={admission.field(slot.key, Boolean(slot.image), false, false, slot.image?.byteSize ?? 0)} onChange={(next) => setReferenceSlots((current) => current.map((item) => item.key === slot.key ? { ...item, image: next } : item))} onStateChange={(state) => setReferenceSlots((current) => current.map((item) => item.key === slot.key ? { ...item, state } : item))} onDraftRestored={(hasImage) => setReferenceSlots((current) => finishReferenceRestore(current, slot.key, hasImage))} participationStatus="参与本次生成" />)}
            </div>
            {referenceSlots.length < maxReferences && <button type="button" className="secondary-button" disabled={!admission.canAdd()} onClick={() => setReferenceSlots((current) => [...current, { key: crypto.randomUUID(), state: "idle", keepEmpty: true }])}>添加参考图</button>}
            {!inputSummary.allowed && <p className="summary-note error-text" role="alert">当前参考图数量、单图大小、总大小或尺寸不符合所选模型，请减少或更换图片后再生成。</p>}
          </section>

          <PromptComposer id="self-service-prompt" value={prompt} onChange={setPrompt} privateTest={privateTest} contextKey={references.map((image) => image.id).join(",")} />
        </div>

        <aside className="studio-inspector zs-params" aria-label="自助生成设置">
          <section className="inspector-group">
            <div className="panel-heading">
              <span>03</span>
              <div>
                <h2>出图参数</h2>
                <p>参考图将自动匹配最近的受支持画面比例。</p>
              </div>
            </div>
            <div className="param-group"><h3 className="param-group-title">模型与画质</h3><div className="output-parameter-row"><div className="model-parameter"><ImageModelSelect value={provider} optionId={modelOption.optionId} onOptionChange={modelOption.select} /></div></div><div className="output-parameter-row"><Segmented label="清晰度" disabledDescription="当前模型不支持的清晰度已禁用。" value={resolution} options={selectedResolutionOptions} onChange={setResolution} /><Segmented label="画面比例" value={aspectRatio} options={["1:1", "4:3", "3:2", "16:9", "9:16"].map((value) => ({ value, label: value, disabled: true }))} onChange={() => undefined} description={`当前自动比例：${aspectRatio}；根据第一张参考图自动匹配，无参考图时使用4:3。`} disabledDescription="画面比例自动匹配，不可手动修改。" /></div>
            </div><div className="param-group param-submit"><h3 className="param-group-title">输出与提交</h3><OutputCounter value={outputCount} onChange={setOutputCount} busy={controller.busy} />
            <div className="summary-card"><div className="summary-title"><span>任务摘要</span><small>{outputCount}张输出</small></div>
            <dl className="task-summary"><div><dt>图像模型</dt><dd>{getPublicModelOption(modelOption.optionId)?.label ?? imageModelOptions.find((item) => item.value === provider)?.label}</dd></div>
              <div><dt>参考图</dt><dd>{references.length ? `${references.length} 张` : "未上传"}</dd></div>
              <div><dt>画面比例</dt><dd>{aspectRatio}</dd></div>
              <div><dt>提示词</dt><dd>{prompt.trim() ? `${prompt.trim().length} 字` : "未填写"}</dd></div>
              <div><dt>清晰度</dt><dd>{resolution}</dd></div>
              <div><dt>模型质量</dt><dd>{imageQualityLabel(quality)}</dd></div>
            </dl></div>
            <div className="generation-actions">
              <button className="primary-button" type="button" disabled={!canGenerate || !pricing.final || pricing.insufficient} onClick={() => void generate()}>{privateTest ? "提交生图" : <>提交生图 · {pricing.final ? `${pricing.final.totalCredits}积分` : pricing.error ? "报价失败" : "报价中"}</>}</button>
            </div>
            <GenerationPriceDetails quote={pricing.final} />{pricing.insufficient && <p className="summary-note error-text" role="status">可用积分不足，请先充值后再生成。</p>}{pricing.error && <p className="summary-note error-text" role="alert">{pricing.error}</p>}</div>

          </section>
        </aside>

        <section className="studio-results" aria-label="自助生成结果">
          <div className="results-heading">
            <div><span className="section-kicker">RESULTS</span><h2>生成结果</h2></div>
          </div>
          <GenerationView optionId={modelOption.optionId} providerPreference={provider} controller={controller} resolution={resolution} quality={quality} />
          <StudioTaskList workflowType="self-service" refreshKey={controller.job?.id ?? ""} />
        </section>
      </div>
    </div>
  );
}
