"use client";

/* eslint-disable @next/next/no-img-element -- Blob/API image URLs need native image sizing and object-fit previews. */

import { useSession, useSessionError, loadSession, requireClientAccess } from "@/components/site/session";
import { isDomesticImageModel } from "@/lib/domain/domestic-image-models";
import { Dispatch, SetStateAction, ChangeEvent, DragEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssetRecord, readImageDimensions, StyleRecord, listStyles } from "@/components/site/api";
import { loadDraftImage, removeDraftImage, saveDraftImage } from "@/components/studio/browser-drafts";
import { imageFitsModel } from "@/components/studio/input-limits";
import { ACCEPTED_IMAGE_MIME_TYPES, MAX_INPUT_IMAGE_BYTES, MAX_INPUT_IMAGE_PIXELS, MAX_INPUT_IMAGE_SIDE } from "@/lib/domain/image-input-limits";
import { imageModelCapabilities, imageModelOptions, imageQualityOptions, type ImageModel, type ImageQuality } from "@/lib/domain/image-models";

export type UploadedImage = AssetRecord & { width?: number; height?: number; draftVersion?: string };
export type UploadGate = { disabledReason?: string; begin: (file: File) => boolean; complete: () => boolean; finish: (success: boolean) => void; settle: () => void };

const fallbackStyles: StyleRecord[] = [];
/* Style names, descriptions and previews are server-owned; never duplicate them here. */
/*
  { id: "modern-minimalist", name: "现代简约", description: "干净线条与克制中性色", imageUrl: "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=760&q=82" },
  { id: "cream-cozy", name: "奶油风", description: "柔和米白与圆润家具", imageUrl: "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=760&q=82" },
  { id: "wabi-sabi", name: "侘寂风", description: "自然肌理与安静留白", imageUrl: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=760&q=82" },
  { id: "italian-minimalist", name: "意式极简", description: "精确比例与材质对比", imageUrl: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=760&q=82" },
  { id: "contemporary-luxury", name: "现代轻奢", description: "石材、金属与精致灯光", imageUrl: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=760&q=82" },
  { id: "nordic-natural", name: "北欧自然", description: "浅木、自然光与日常舒适", imageUrl: "https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?auto=format&fit=crop&w=760&q=82" },
  { id: "new-chinese", name: "新中式", description: "现代比例与东方木作", imageUrl: "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?auto=format&fit=crop&w=760&q=82" },
  { id: "mid-century-modern", name: "中古现代", description: "温润木色与经典家具", imageUrl: "https://images.unsplash.com/photo-1615874694520-474822394e73?auto=format&fit=crop&w=760&q=82" },
  { id: "japandi", name: "日式原木", description: "清浅木色与低重心家具", imageUrl: "https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&w=760&q=82" },
  { id: "french-modern", name: "法式现代", description: "简化线板与优雅比例", imageUrl: "https://images.unsplash.com/photo-1615529162924-f8605388461d?auto=format&fit=crop&w=760&q=82" },
  { id: "industrial-loft", name: "工业质感", description: "深色金属与粗粝表面", imageUrl: "https://images.unsplash.com/photo-1600563438938-a9a27216b4f5?auto=format&fit=crop&w=760&q=82" },
  { id: "coastal-relaxed", name: "海岸松弛", description: "明亮织物与轻盈自然色", imageUrl: "https://images.unsplash.com/photo-1600566753051-f0b89df2dd90?auto=format&fit=crop&w=760&q=82" },
]; */

export function useStylePresets() {
  const [styles, setStyles] = useState(fallbackStyles);
  const [available, setAvailable] = useState(false);
  const [message, setMessage] = useState("正在读取可用风格…");

  useEffect(() => {
    let active = true;
    listStyles().then((remote) => {
      if (!active) return;
      const merged = [...remote];
      const known = new Set(remote.map((style) => style.id));
      for (const fallback of fallbackStyles) if (!known.has(fallback.id)) merged.push(fallback);
      setStyles(merged);
      setAvailable(true);
      setMessage(remote.length < 17 ? "部分风格仍等待服务端启用；提交时以后端校验为准。" : "风格服务已连接");
    }).catch((reason) => {
      if (!active) return;
      setAvailable(false);
      setMessage(reason instanceof Error ? reason.message : "风格服务暂时不可用。");
    });
    return () => { active = false; };
  }, []);

  return { styles, available, message };
}

export function ImageUploadField({
  title,
  hint,
  kind,
  value,
  onChange,
  onStateChange,
  onDraftRestored,
  compact = false,
  participationStatus,
  draftKey,
  uploadGate,
  model,
  uploadContext,
  disabled = false,
}: {
  title: string;
  hint: string;
  kind: string;
  value?: UploadedImage;
  onChange: (value?: UploadedImage) => void;
  onStateChange?: (state: "idle" | "uploading" | "ready" | "error") => void;
  onDraftRestored?: (hasImage: boolean) => void;
  compact?: boolean;
  draftKey?: string;
  /** Explicitly states whether this upload is sent by the current workflow. */
  participationStatus?: "参与本次生成" | "启用对应结构模式后参与" | "局部编辑时不参与" | "毛坯还原时不参与" | "当前未启用局部编辑";
  uploadGate?: UploadGate;
  model?: ImageModel;
  uploadContext?: () => boolean;
  disabled?: boolean;
}) {
  const session = useSession();
  const sessionError = useSessionError();
  const [preview, setPreview] = useState<string>();
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>();
  const [state, setState] = useState<"idle" | "uploading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const objectUrl = useRef<string | null>(null);
  const uploadSequence = useRef(0);
  const loading = useRef(false);
  const valueRef = useRef(value);
  const gateRef = useRef(uploadGate);
  const contextRef = useRef(uploadContext);
  const disabledRef = useRef(disabled);
  const modelRef = useRef(model);
  const activeGate = useRef<UploadGate | undefined>(undefined);
  const awaitingSettle = useRef<{ url: string; gate: UploadGate } | undefined>(undefined);
  const storageKey = `${typeof window === "undefined" ? "studio" : window.location.pathname}:${draftKey ?? `${kind}:${title}`}`;

  useEffect(() => { valueRef.current = value; }, [value]);
  useLayoutEffect(() => { gateRef.current = uploadGate; modelRef.current = model; contextRef.current = uploadContext; disabledRef.current = disabled; }, [uploadGate, model, uploadContext, disabled]);
  useEffect(() => { if (awaitingSettle.current && value?.url === awaitingSettle.current.url) { awaitingSettle.current.gate.settle(); awaitingSettle.current = undefined; } }, [value?.url]);

  function updateState(next: "idle" | "uploading" | "ready" | "error") {
    setState(next);
    onStateChange?.(next);
  }

  useEffect(() => {
    if (!value?.url || value.width || value.height || dimensions || preview) return;
    let active = true;
    readImageDimensions(value.url)
      .then((size) => { if (active) setDimensions(size); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [dimensions, preview, value]);

  useEffect(() => {
    let active = true;
    if (!valueRef.current) loadDraftImage(storageKey).then((restored) => {
      if (!active || (uploadContext && !uploadContext()) || valueRef.current) { if (restored) URL.revokeObjectURL(restored.url); return; }
      onDraftRestored?.(Boolean(restored));
      if (!restored) return;
      objectUrl.current = restored.url;
      setPreview(restored.url);
      setDimensions(restored.width && restored.height ? { width: restored.width, height: restored.height } : undefined);
      onChange(restored);
      updateState("ready");
    }).catch(() => undefined);
    return () => { active = false; };
    // Restore exactly once for this stable slot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => () => {
    uploadSequence.current += 1;
    activeGate.current?.finish(false);
    activeGate.current = undefined;
    awaitingSettle.current?.gate.settle();
    awaitingSettle.current = undefined;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
  }, []);

  async function choose(file?: File) {
    if (disabledRef.current || !requireClientAccess() || !file || loading.current || awaitingSettle.current) return;
    const startedGate = gateRef.current;
    const startedContext = () => !disabledRef.current && contextRef.current?.() !== false;
    if (startedContext && !startedContext()) return;
    if (startedGate && !startedGate.begin(file)) { setError("当前模型输入图数量或总大小已达到上限；原图片仍保留。"); setState("error"); return; }
    loading.current = true;
    activeGate.current = startedGate;
    const sequence = ++uploadSequence.current;
    setError("");
    if (!(ACCEPTED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) { startedGate?.finish(false); activeGate.current = undefined; loading.current = false; updateState("error"); setError("仅支持 JPG、PNG 或 WebP 图片。"); return; }
    if (file.size > MAX_INPUT_IMAGE_BYTES) { startedGate?.finish(false); activeGate.current = undefined; loading.current = false; updateState("error"); setError("文件超过20MB，请压缩后重试。"); return; }
    if (modelRef.current && file.size > imageModelCapabilities[modelRef.current].maxImageBytes) { startedGate?.finish(false); activeGate.current = undefined; loading.current = false; updateState("error"); setError("当前模型的站内单图上限为10MB，请压缩后重试。"); return; }
    const nextUrl = URL.createObjectURL(file);
    setPreview(nextUrl);
    setDimensions(undefined);
    updateState("uploading");
    try {
      const size = await readImageDimensions(nextUrl);
      if (sequence !== uploadSequence.current) { URL.revokeObjectURL(nextUrl); return; }
      setDimensions(size);
      if (size.width > MAX_INPUT_IMAGE_SIDE || size.height > MAX_INPUT_IMAGE_SIDE || size.width * size.height > MAX_INPUT_IMAGE_PIXELS) throw new Error("图片最长边不能超过8192px，且总像素不能超过4000万。");
      const limits = modelRef.current && imageModelCapabilities[modelRef.current].inputDimensions;
      if (limits && ((limits.minSide && Math.min(size.width, size.height) < limits.minSide) || (limits.maxSide && Math.max(size.width, size.height) > limits.maxSide) || (limits.maxPixels && size.width * size.height > limits.maxPixels) || (limits.minRatio && size.width / size.height < limits.minRatio) || (limits.maxRatio && size.width / size.height > limits.maxRatio))) throw new Error("图片尺寸或宽高比超出当前模型已接入的输入限制。");
      const stillAllowed = () => sequence === uploadSequence.current && (!startedContext || startedContext()) && (!modelRef.current || imageFitsModel(modelRef.current, { byteSize: file.size, ...size })) && (!gateRef.current || gateRef.current.complete());
      if (!stillAllowed()) throw new Error("切换模型后输入图超过上限；原图片仍保留，请先移除其他图片。");
      const asset = await saveDraftImage(storageKey, kind, file, size.width, size.height, nextUrl, stillAllowed);
      if (sequence !== uploadSequence.current) { URL.revokeObjectURL(nextUrl); return; }
      if (startedContext && !startedContext()) { startedGate?.finish(false); activeGate.current = undefined; loading.current = false; setPreview(valueRef.current?.url); updateState("idle"); URL.revokeObjectURL(nextUrl); return; }
      const next = { ...asset, ...size };
      objectUrl.current = nextUrl;
      if (startedGate) awaitingSettle.current = { url: nextUrl, gate: startedGate };
      onChange(next);
      startedGate?.finish(true);
      activeGate.current = undefined;
      loading.current = false;
      updateState("ready");
    } catch (reason) {
      if (sequence !== uploadSequence.current) { URL.revokeObjectURL(nextUrl); return; }
      startedGate?.finish(false);
      activeGate.current = undefined;
      loading.current = false;
      URL.revokeObjectURL(nextUrl);
      setPreview(valueRef.current?.url);
      if (!startedContext()) { setDimensions(undefined); updateState(valueRef.current ? "ready" : "idle"); setError(""); return; }
      updateState("error");
      setError(reason instanceof Error ? reason.message : "图片读取失败。");
    }
  }

  function clear() {
    if (disabledRef.current || (uploadContext && !uploadContext())) return;
    uploadSequence.current += 1;
    activeGate.current?.finish(false);
    activeGate.current = undefined;
    awaitingSettle.current?.gate.settle();
    awaitingSettle.current = undefined;
    loading.current = false;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setPreview(undefined);
    setDimensions(undefined);
    updateState("idle");
    setError("");
    onChange(undefined);
    void removeDraftImage(storageKey);
  }

  const displayPreview = preview ?? value?.url;
  const displayDimensions = dimensions ?? (value?.width && value?.height ? { width: value.width, height: value.height } : undefined);
  const displayState = state === "error" ? "error" : value && !preview ? "ready" : state;

  return (
    <section className={`upload-field ${compact ? "compact" : ""}`}>
      <div className="upload-field-head"><div><h3>{title}</h3><p>{hint}</p></div>{(displayPreview || state === "error") && <button type="button" disabled={disabled} onClick={clear}>{displayPreview ? "移除" : "清除错误"}</button>}</div>
      <label className={`image-drop ${dragging ? "dragging" : ""} ${displayState === "error" ? "has-error" : ""} ${uploadGate?.disabledReason ? "upload-disabled" : ""}`} aria-disabled={disabled || Boolean(uploadGate?.disabledReason)} onDragOver={(event) => { event.preventDefault(); if (!disabledRef.current && !gateRef.current?.disabledReason) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); setDragging(false); void choose(event.dataTransfer.files?.[0]); }}>
        <input type="file" onClick={(event) => { if (!requireClientAccess()) event.preventDefault(); }} disabled={disabled || Boolean(uploadGate?.disabledReason)} accept="image/jpeg,image/png,image/webp" aria-label={`选择${title}`} onChange={(event: ChangeEvent<HTMLInputElement>) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
        {displayPreview ? <img src={displayPreview} alt={`${title}完整预览`} /> : <span className="drop-copy"><b aria-hidden="true">＋</b><strong>拖入或选择图片</strong></span>}
      </label>
      {!session && <div className="field-description" role="status">{sessionError ?? "正在确认登录状态，暂不能选择图片。"}{sessionError && <button type="button" className="text-button" onClick={() => void loadSession(true).catch(() => undefined)}>重新连接</button>}</div>}
      {(displayState !== "idle" || displayDimensions || uploadGate?.disabledReason) && <div className={`upload-status ${displayState}`} aria-live="polite"><span>{uploadGate?.disabledReason ?? (displayState === "uploading" ? "正在读取…" : displayState === "ready" ? (value?.local ? "已保存在当前标签页，提交时上传" : "已载入") : displayState === "error" ? error : "")}</span>{displayDimensions && <em>{displayDimensions.width} × {displayDimensions.height}px</em>}</div>}
      {participationStatus && value && <p className="upload-participation-status">{participationStatus}</p>}
    </section>
  );
}

export function StylePicker({ styles, value, onChange }: { styles: StyleRecord[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="style-scroll" role="group" aria-label="设计风格">
      <div className="style-picker-grid">
        {styles.map((style) => (
          <button key={style.id} className={`style-option ${value === style.id ? "selected" : ""}`} type="button" aria-pressed={value === style.id} onClick={() => onChange(style.id)}>
            <span className="style-option-image">{style.imageUrl ? <img src={style.imageUrl} alt="" /> : <span aria-hidden="true">◇</span>}{value === style.id && <i aria-hidden="true">✓</i>}</span>
            <strong>{style.name}</strong><small>{style.description}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange, description, disabledDescription }: { label: string; value: T; options: readonly { value: T; label: string; note?: string; disabled?: boolean }[]; onChange: (value: T) => void; description?: string; disabledDescription?: string }) {
  return (
    <fieldset className="field-set" data-label={label}><legend>{label}</legend>{description && <p className="field-description">{description}</p>}<div className="segmented-control">{options.map((option) => <button key={option.value} type="button" data-value={option.value} disabled={option.disabled} aria-pressed={value === option.value} className={value === option.value ? "selected" : ""} title={option.note} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>{options.find((option) => option.value === value)?.note && <p className="field-description">{options.find((option) => option.value === value)?.note}</p>}{options.some((option) => option.disabled) && <p className="field-description">{disabledDescription ?? "当前模型的输入图名额不足时，对应结构模式不可选；可先移除其他参考图。"}</p>}</fieldset>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange, description, disabled }: { label: string; value: T; options: readonly { value: T; label: string; note?: string; disabled?: boolean }[]; onChange: (value: T) => void; description?: string; disabled?: boolean }) {
  const selected = options.find((option) => option.value === value);
  return <label className="select-field"><span>{label}</span><select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value as T)}>{options.map((option) => <option key={option.value} disabled={option.disabled} value={option.value}>{option.label}</option>)}</select>{description && <small className="field-description">{description}</small>}{selected?.note && <small className="field-description">{selected.note}</small>}</label>;
}

export function usePrivateTestMode(): boolean | undefined {
  const session = useSession();
  return session ? session.authMode === "private-test" : undefined;
}

export function ImageModelSelect({ value, onChange }: { value: ImageModel; onChange: (value: ImageModel) => void }) {
  const privateTest = usePrivateTestMode();
  const unavailable = privateTest === false && !isDomesticImageModel(value);
  const available = imageModelOptions.filter(option => privateTest === true || isDomesticImageModel(option.value));
  return <><label className="select-field image-model-field"><span>图像模型</span><select disabled={privateTest === undefined} value={unavailable ? "" : value} onChange={event => onChange(event.target.value as ImageModel)}>{unavailable && <option value="" disabled>旧稿模型暂不可用，请重新选择</option>}{available.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{(privateTest === undefined || unavailable) && <small className="field-description">{privateTest === undefined ? "正在确认模型权限。" : "旧稿模型暂不公开；原草稿与历史仍保留，请选择一个国内模型继续。"}</small>}</label>{!unavailable && <ModelCapabilityDetails model={value} privateTest={privateTest} />}</>;
}

export function OutputCounter({ value, onChange, busy }: { value: number; onChange: Dispatch<SetStateAction<number>>; busy: boolean }) {
  return <div className="output-counter"><span><strong>输出数量</strong><small>1—4张</small></span><div><button type="button" aria-label="减少输出数量" disabled={value === 1 || busy} onClick={() => onChange((count) => Math.max(1, count - 1))}>−</button><b>{value}</b><button type="button" aria-label="增加输出数量" disabled={value === 4 || busy} onClick={() => onChange((count) => Math.min(4, count + 1))}>＋</button></div></div>;
}

export function QualityField({ model, value, onChange }: { model: ImageModel; value: ImageQuality; onChange: (value: ImageQuality) => void }) {
  const supported = imageModelCapabilities[model].nativeQualities;
  return <Segmented label="模型质量" value={value} options={imageQualityOptions.map((option) => ({ ...option, disabled: !supported.includes(option.value) }))} onChange={onChange} description="模型原生质量与清晰度分别设置。" disabledDescription={supported.length ? "当前模型不支持的质量档位已禁用。" : "当前模型未提供原生质量档位；由模型自动处理，六档均不可选。"} />;
}

export function ModelCapabilityDetails({ model, privateTest = false }: { model: ImageModel; privateTest?: boolean }) {
  const capability = imageModelCapabilities[model];
  return <><details className="model-capability-details"><summary>模型能力与当前接入范围</summary><p><strong>官方能力</strong>{capability.officialSummary}</p><small>官方输出规格：{capability.officialResolutions.join(" / ")}</small><p><strong>造室当前</strong>{capability.siteSummary}</p><small>当前可选规格：{capability.supportedResolutions.join(" / ")}。多张输出均为独立方案，不等同于内容关联组图；风格、灯光、家具、材质、Depth 与 Normal 均通过提示词和有序参考图提供软引导。</small></details>{privateTest && <p className="summary-note" role="note">SSH 私测免站内积分；规格按所选模型已接入选项。每次可选 1–4 张，逐张执行且同时仅 1 张。手动上传的 Depth / Normal 仅作软参考。图片仍受通用上传和所选模型的输入限制。每次提交前仍需确认供应商 API 费用。</p>}</>;
}

export function GenerationPriceDetails({ quote }: { quote?: { inputCredits: number; amountPerItem: number; outputCount: number } }) {
  const session = useSession();
  return quote ? <small className="field-description">每张输出 {quote.amountPerItem} 积分，其中输入参考图附加 {quote.inputCredits} 积分；共 {quote.outputCount} 张。每张独立发送所有输入图，提交时最终核价。{session?.credits && ` 可用 ${session.credits.available} 积分，冻结 ${session.credits.reserved} 积分。`} 确认失败且无需结算的输出会释放冻结；结果不确定时先核实。</small> : null;
}
