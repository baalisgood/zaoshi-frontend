"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ImageUploadField, UploadedImage } from "@/components/studio/StudioFields";
import { imageModelCapabilities, type ImageModel } from "@/lib/domain/image-models";
import { loadParameterDraft, saveParameterDraft } from "@/components/studio/browser-drafts";
import { createUploadAdmission } from "@/components/studio/input-limits";

export type ReferenceKind = "concept" | "advanced";
const softSlotIds = ["soft-slot-1", "soft-slot-2", "soft-slot-3", "soft-slot-4"];

type Props = {
  workflow: ReferenceKind;
  selectionContent?: ReactNode;
  localEditing?: boolean;
  source?: UploadedImage;
  onSourceChange: (image?: UploadedImage) => void;
  styleReference?: UploadedImage;
  onStyleReferenceChange: (image?: UploadedImage) => void;
  onStyleReferenceStateChange?: (state: "idle" | "uploading" | "ready" | "error") => void;
  softReferences?: (UploadedImage | undefined)[];
  onSoftReferencesChange?: (images: (UploadedImage | undefined)[]) => void;
  depth?: UploadedImage;
  onDepthChange?: (image?: UploadedImage) => void;
  normal?: UploadedImage;
  onNormalChange?: (image?: UploadedImage) => void;
  materialReferences?: UploadedImage[];
  onMaterialReferencesChange?: (images: UploadedImage[]) => void;
  colorReferences?: UploadedImage[];
  onColorReferencesChange?: (images: UploadedImage[]) => void;
  compositionReferences?: UploadedImage[];
  onCompositionReferencesChange?: (images: UploadedImage[]) => void;
  structureReference?: UploadedImage;
  onStructureReferenceChange?: (image?: UploadedImage) => void;
  onOpenSelection?: () => void;
  onUploadsStateChange?: (blocked: boolean) => void;
  model: ImageModel;
  inputCount: number;
  inputBytes: number;
  inputsAllowed: boolean;
  controlMode?: "none" | "depth" | "depth-normal";
  controlSourceVersion?: string;
  controlSourceCurrent?: () => boolean;
  referenceHints?: { role: string; count: number }[];
};

/** Shared left-side input vocabulary. Every accepted reference is submitted with its fixed role. */
export function ReferenceTray({ selectionContent, localEditing = false, workflow, source, onSourceChange, styleReference, onStyleReferenceChange, onStyleReferenceStateChange, softReferences = [], onSoftReferencesChange, depth, onDepthChange, normal, onNormalChange, materialReferences = [], onMaterialReferencesChange, colorReferences = [], onColorReferencesChange, compositionReferences = [], onCompositionReferencesChange, onStructureReferenceChange, structureReference, onOpenSelection, onUploadsStateChange, model, inputCount, inputBytes, inputsAllowed, controlMode = "none", controlSourceVersion, controlSourceCurrent, referenceHints = [] }: Props) {
  const [notice, setNotice] = useState("");
  const [localSoftReferences, setLocalSoftReferences] = useState<(UploadedImage | undefined)[]>(softReferences);
  const [localMaterialReferences, setLocalMaterialReferences] = useState<UploadedImage[]>(materialReferences);
  const [localColorReferences, setLocalColorReferences] = useState<UploadedImage[]>(colorReferences);
  const [localCompositionReferences, setLocalCompositionReferences] = useState<UploadedImage[]>(compositionReferences);
  const [visibleSoftSlots, setVisibleSoftSlots] = useState(() => Math.max(1, softReferences.length));
  const [slotCountReady, setSlotCountReady] = useState(false);
  const [uploadStates, setUploadStates] = useState<Record<string, "idle" | "uploading" | "ready" | "error">>({});
  const [admission] = useState(() => createUploadAdmission());
  const currentSoftReferences = onSoftReferencesChange ? softReferences : localSoftReferences;
  const softReferencesRef = useRef<(UploadedImage | undefined)[]>(currentSoftReferences);
  const currentMaterialReferences = onMaterialReferencesChange ? materialReferences : localMaterialReferences;
  const currentColorReferences = onColorReferencesChange ? colorReferences : localColorReferences;
  const currentCompositionReferences = onCompositionReferencesChange ? compositionReferences : localCompositionReferences;
  const saveSoftReferences = (images: (UploadedImage | undefined)[]) => onSoftReferencesChange ? onSoftReferencesChange(images) : setLocalSoftReferences(images);
  useEffect(() => { softReferencesRef.current = currentSoftReferences; }, [currentSoftReferences]);
  const saveLatestSoftReferences = (images: (UploadedImage | undefined)[]) => { softReferencesRef.current = images; saveSoftReferences(images); };
  useEffect(() => { const saved = loadParameterDraft(`${workflow}:reference-slots`); queueMicrotask(() => { if (typeof saved?.count === "number") setVisibleSoftSlots(Math.max(1, Math.min(14, saved.count))); setSlotCountReady(true); }); }, [workflow]);
  useEffect(() => { if (slotCountReady) saveParameterDraft(`${workflow}:reference-slots`, { count: visibleSoftSlots }); }, [slotCountReady, visibleSoftSlots, workflow]);
  const saveMaterialReferences = (images: UploadedImage[]) => onMaterialReferencesChange ? onMaterialReferencesChange(images) : setLocalMaterialReferences(images);
  const saveColorReferences = (images: UploadedImage[]) => onColorReferencesChange ? onColorReferencesChange(images) : setLocalColorReferences(images);
  const saveCompositionReferences = (images: UploadedImage[]) => onCompositionReferencesChange ? onCompositionReferencesChange(images) : setLocalCompositionReferences(images);
  const safeDepthChange = onDepthChange ?? (() => undefined);
  const safeNormalChange = onNormalChange ?? (() => undefined);
  const setUploadState = (name: string, state: "idle" | "uploading" | "ready" | "error") => setUploadStates((current) => ({ ...current, [name]: state }));
  useEffect(() => { onUploadsStateChange?.(Object.values(uploadStates).some((state) => state === "uploading" || state === "error")); }, [onUploadsStateChange, uploadStates]);
  const isAdvanced = workflow === "advanced";
  const maxInputImages = imageModelCapabilities[model].maxInputImages;
  const reserved = (source ? 0 : 1) + (controlMode !== "none" && !depth ? 1 : 0) + (controlMode === "depth-normal" && !normal ? 1 : 0);
  admission.update(model, inputCount, reserved, inputBytes, !inputsAllowed, (controlMode !== "none" ? depth?.byteSize ?? 0 : 0) + (controlMode === "depth-normal" ? normal?.byteSize ?? 0 : 0), (controlMode !== "none" && depth ? 1 : 0) + (controlMode === "depth-normal" && normal ? 1 : 0));
  const supportsNativeInteractiveEdit = imageModelCapabilities[model].nativeInteractiveEdit;
  const suggestedSoftCount = referenceHints.filter((hint) => hint.role === "furnishing" || hint.role === "reference").reduce((sum, hint) => sum + hint.count, 0);
  const renderedSoftSlots = Math.max(visibleSoftSlots, Math.min(maxInputImages, Math.max(currentSoftReferences.length, suggestedSoftCount || 1)));
  const updateSoft = (index: number, image?: UploadedImage) => {
    const next = [...softReferencesRef.current];
    if (image) next[index] = image;
    else next[index] = undefined;
    saveLatestSoftReferences(next);
  };
  const singleReference = (name: string, title: string, hint: string, kind: string, value: UploadedImage | undefined, onChange: (image?: UploadedImage) => void, status: "参与本次生成" | "启用对应结构模式后参与", onStateChange?: (state: "idle" | "uploading" | "ready" | "error") => void) => <fieldset className="reference-input-group" disabled={localEditing && name !== "source"}><ImageUploadField compact draftKey={`${workflow}:${name}`} title={title} hint={hint} kind={kind} value={value} model={model} onChange={onChange} onStateChange={(state) => { setUploadState(name, state); onStateChange?.(state); }} participationStatus={localEditing ? "局部编辑时不参与" : status} uploadGate={admission.field(name, Boolean(value), name === "source", name === "source", value?.byteSize ?? 0)} disabled={localEditing && name !== "source"} /></fieldset>;
  return <section className="reference-tray" aria-label="参考素材与局部选区">
    <div className="panel-heading"><span>01</span><div><h2>参考素材</h2><p>图片先保存在当前标签页，点击生成后才上传。{localEditing ? "局部编辑使用下方独立原图和局部参考；上方素材不参与本次生成。" : `输入图片 ${inputCount}/${maxInputImages}（包含底图）。`}</p></div></div>
    <div className="reference-tray-grid">
      {singleReference("source", isAdvanced ? "结构参考" : "现场 / 方案基底", "必填 · 现场照片或当前方案基底", "source", source, onSourceChange, "参与本次生成")}
      {singleReference("style", "风格参考", "可选 · 色调、材质与氛围", "reference", styleReference, onStyleReferenceChange, "参与本次生成", onStyleReferenceStateChange)}
      <fieldset className="reference-slot-group reference-input-group" disabled={localEditing}><div className="reference-slot-heading"><div><strong>家具 / 软装参考</strong><small>可添加家具、灯具等软装实物图{suggestedSoftCount > 0 ? ` · 当前参数建议 ${suggestedSoftCount} 张` : ""}</small></div>{renderedSoftSlots < maxInputImages && <button type="button" className="text-button" disabled={localEditing || !admission.canAdd()} onClick={() => setVisibleSoftSlots(renderedSoftSlots + 1)}>＋添加参考图</button>}</div><div className="reference-slot-list">
        {Array.from({ length: renderedSoftSlots }, (_, index) => <div key={softSlotIds[index] ?? `soft-slot-${index + 1}`} className={!currentSoftReferences[index] && index < suggestedSoftCount ? "reference-slot-suggested" : undefined}><ImageUploadField draftKey={`${workflow}:soft:${index}`} compact disabled={localEditing} title={`家具 / 软装参考 ${index + 1}`} hint="可选" kind="reference" value={currentSoftReferences[index]} model={model} uploadGate={admission.field(`soft-${index}`, Boolean(currentSoftReferences[index]), false, false, currentSoftReferences[index]?.byteSize ?? 0)} onStateChange={(state) => setUploadState(`soft-${index}`, state)} participationStatus={localEditing ? "局部编辑时不参与" : "参与本次生成"} onChange={(next) => { if (next) { const updated = [...softReferencesRef.current]; updated[index] = next; saveLatestSoftReferences(updated); setVisibleSoftSlots((count) => Math.max(count, index + 1)); setNotice("已加入家具 / 软装参考，本次任务将一并发送。"); } else { updateSoft(index); } }} /></div>)}
      </div></fieldset>
      {isAdvanced && <>
        {singleReference("material", "材质参考", "可选 · 石材、木饰面、织物等表面参考", "reference", currentMaterialReferences[0], (image) => saveMaterialReferences(image ? [image] : []), "参与本次生成")}
        {singleReference("color", "色彩 / 灯光参考", "可选 · 色板、氛围或灯光参考", "reference", currentColorReferences[0], (image) => saveColorReferences(image ? [image] : []), "参与本次生成")}
        {singleReference("composition", "构图参考", "可选 · 视角、取景或构图参考", "reference", currentCompositionReferences[0], (image) => saveCompositionReferences(image ? [image] : []), "参与本次生成")}
        {singleReference("structure", "门窗 / 结构参考", "可选 · 门、窗、楼梯等结构实物参考", "reference", structureReference, onStructureReferenceChange ?? (() => undefined), "参与本次生成")}
        {controlSourceVersion ? <>
          <ImageUploadField key={`depth:${controlSourceVersion}`} draftKey={`${workflow}:depth:${controlSourceVersion}`} compact disabled={localEditing} title="Depth 深度参考" hint="相对远近的软参考，不是测量图" kind="depth" value={depth} model={model} uploadContext={controlSourceCurrent} onChange={safeDepthChange} onStateChange={(state) => setUploadState("depth", state)} participationStatus={localEditing ? "局部编辑时不参与" : "启用对应结构模式后参与"} uploadGate={controlMode === "none" ? { ...admission.field("depth", Boolean(depth), true, false, depth?.byteSize ?? 0), disabledReason: depth ? undefined : "请先选择深度结构模式。", begin: () => Boolean(depth), complete: () => Boolean(depth) } : admission.field("depth", Boolean(depth), true, false, depth?.byteSize ?? 0)} />
          <ImageUploadField key={`normal:${controlSourceVersion}`} draftKey={`${workflow}:normal:${controlSourceVersion}`} compact disabled={localEditing} title="Normal 法线参考" hint="表面朝向的软参考，不是材质图" kind="normal" value={normal} model={model} uploadContext={controlSourceCurrent} onChange={safeNormalChange} onStateChange={(state) => setUploadState("normal", state)} participationStatus={localEditing ? "局部编辑时不参与" : "启用对应结构模式后参与"} uploadGate={controlMode !== "depth-normal" ? { ...admission.field("normal", Boolean(normal), true, false, normal?.byteSize ?? 0), disabledReason: normal ? undefined : "请先选择深度＋法线结构模式。", begin: () => Boolean(normal), complete: () => Boolean(normal) } : admission.field("normal", Boolean(normal), true, false, normal?.byteSize ?? 0)} />
        </> : null}
      </>}
    </div>
    {selectionContent ?? <div className="selection-entry"><div className="selection-entry-copy"><strong>局部选区</strong><p>{!source ? "请先上传底图，再编辑局部选区。" : supportsNativeInteractiveEdit ? "当前模型官方支持标注式交互编辑；造室本版仅在本地保存标注，尚不会随任务发送。" : "当前模型没有已接入的硬蒙版接口；标注只保存在本地，不参与本次生成。"}</p></div><div className="selection-example" aria-label="标注示意：圈选沙发"><div className="selection-example-canvas" style={{ backgroundImage: 'url("/demo/scene.svg")' }} aria-hidden="true"><i className="selection-example-mark" /><span>圈选沙发</span></div><small>操作示意：圈选沙发；本地标注当前不参与生成</small></div><button type="button" className="secondary-button" onClick={onOpenSelection} disabled={!onOpenSelection || !source}>编辑选区</button></div>}
    {inputCount > maxInputImages && <p className="summary-note error-text" role="alert">切换模型后当前输入超出上限；图片不会被删除，请减少到 {maxInputImages} 张后提交。</p>}{notice && <p className="reference-notice" role="status">{notice}</p>}{Object.values(uploadStates).some((state) => state === "error") && <p className="summary-note error-text" role="alert">有参考图读取失败，请移除或重新选择后再提交。</p>}
  </section>;
}
