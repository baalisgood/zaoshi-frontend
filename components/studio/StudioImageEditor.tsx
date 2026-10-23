"use client";

/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */

import { PointerEvent, useEffect, useRef, useState } from "react";
import { saveDraftImage } from "@/components/studio/browser-drafts";
import type { SelectionFiles } from "./LocalSelection";
import { UploadedImage } from "@/components/studio/StudioFields";

type Point = { x: number; y: number };
type CropRect = { x: number; y: number; w: number; h: number };
type Stroke = { points: Point[]; size: number; erase: boolean };
type Tool = "brush" | "eraser" | "crop";

function rectFromPoints(start: Point, end: Point): CropRect { return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) }; }

export function StudioImageEditor({ image, initialMask, onSelectionSaved, onClose, onMaskSaved }: { image?: UploadedImage; initialMask?: UploadedImage; onSelectionSaved?: (files: SelectionFiles) => Promise<void>; onClose: () => void; onMaskSaved?: (mask?: UploadedImage, editedBase?: UploadedImage) => void }) {
  const initialMaskRef = useRef<HTMLImageElement | undefined>(undefined); const alive = useRef(true); const savingRef = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const previewCanvas = useRef<HTMLCanvasElement>(null); const maskCanvas = useRef<HTMLCanvasElement>(null); const baseCanvas = useRef<HTMLCanvasElement | undefined>(undefined); const dialogRef = useRef<HTMLElement>(null); const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null); const sourceRef = useRef<HTMLImageElement | undefined>(undefined); const originalSrc = useRef<string | undefined>(undefined); const cropStart = useRef<Point | undefined>(undefined);
  const [loaded, setLoaded] = useState(false); const [imageVersion, setImageVersion] = useState(0); const [selectionScanVersion, setSelectionScanVersion] = useState(0); const [hasSelection, setHasSelection] = useState(false); const [baseEdited, setBaseEdited] = useState(false); const [tool, setTool] = useState<Tool>("brush"); const [size, setSize] = useState(36); const [strokes, setStrokes] = useState<Stroke[]>([]); const [redo, setRedo] = useState<Stroke[]>([]); const [drawing, setDrawing] = useState(false); const [rotation, setRotation] = useState(0); const [crop, setCrop] = useState<CropRect>(); const [message, setMessage] = useState(""); const [saving, setSaving] = useState(false);

  useEffect(() => { triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; closeButtonRef.current?.focus(); const keepFocus = (event: FocusEvent) => { if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) closeButtonRef.current?.focus(); }; document.addEventListener("focusin", keepFocus); return () => { document.removeEventListener("focusin", keepFocus); triggerRef.current?.focus(); }; }, []);
  useEffect(() => {
    if (!image?.url) return;
    let active = true; const source = new Image(); const maskUrl = initialMask?.url; const savedMask = maskUrl ? new Image() : undefined;
    const fail = () => { if (active) { setLoaded(false); setMessage("无法读取底图或已保存选区，请重新选择。"); } };
    const ready = () => {
      if (!active) return;
      if (savedMask && (savedMask.naturalWidth !== source.naturalWidth || savedMask.naturalHeight !== source.naturalHeight)) { fail(); return; }
      sourceRef.current = source; initialMaskRef.current = savedMask; originalSrc.current = image.url; baseCanvas.current = undefined;
      setRotation(0); setStrokes([]); setRedo([]); setCrop(undefined); setBaseEdited(false); setHasSelection(Boolean(savedMask)); setLoaded(true); setImageVersion((version) => version + 1);
    };
    source.onload = () => { if (savedMask) { savedMask.onload = ready; savedMask.onerror = fail; savedMask.src = maskUrl!; } else ready(); };
    source.onerror = fail; source.src = image.url;
    return () => { active = false; source.onload = null; source.onerror = null; if (savedMask) { savedMask.onload = null; savedMask.onerror = null; } };
  }, [image?.url, initialMask?.url]);

  function canvasPoint(event: PointerEvent<HTMLCanvasElement>): Point { const canvas = previewCanvas.current; if (!canvas) return { x: 0, y: 0 }; const box = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(canvas.width, ((event.clientX - box.left) / Math.max(1, box.width)) * canvas.width)), y: Math.max(0, Math.min(canvas.height, ((event.clientY - box.top) / Math.max(1, box.height)) * canvas.height)) }; }
  // Canvas refs are intentionally mutable drawing buffers, not render state.
  function renderBase(source: HTMLImageElement, angle: number) {
    const sw = source.naturalWidth || source.width; const sh = source.naturalHeight || source.height; const width = angle % 180 === 0 ? sw : sh; const height = angle % 180 === 0 ? sh : sw;
    // eslint-disable-next-line react-hooks/immutability
    const output = baseCanvas.current ?? document.createElement("canvas"); output.width = width; output.height = height; const context = output.getContext("2d"); if (!context) return output; context.clearRect(0, 0, width, height); context.save(); context.translate(width / 2, height / 2); context.rotate(angle * Math.PI / 180); context.drawImage(source, -sw / 2, -sh / 2, sw, sh); context.restore(); baseCanvas.current = output; return output;
  }
  function draw(next = strokes, angle = rotation, cropRect: CropRect | null | undefined = crop) {
    const canvas = previewCanvas.current; const mask = maskCanvas.current; const source = sourceRef.current; if (!canvas || !mask || !source) return;
    const base = renderBase(source, angle); const width = base.width; const height = base.height;
    canvas.width = width; canvas.height = height; mask.width = width; mask.height = height;
    const ctx = canvas.getContext("2d"); const mctx = mask.getContext("2d"); if (!ctx || !mctx) return;
    ctx.clearRect(0, 0, width, height); ctx.drawImage(base, 0, 0);
    mctx.clearRect(0, 0, width, height); mctx.fillStyle = "white"; mctx.fillRect(0, 0, width, height);
    if (initialMaskRef.current) { mctx.clearRect(0, 0, width, height); mctx.drawImage(initialMaskRef.current, 0, 0); }
    const overlay = document.createElement("canvas"); overlay.width = width; overlay.height = height;
    const octx = overlay.getContext("2d"); if (!octx) return;
    if (initialMaskRef.current) { octx.fillStyle = "#e04439"; octx.fillRect(0, 0, width, height); octx.globalCompositeOperation = "destination-out"; octx.drawImage(initialMaskRef.current, 0, 0); octx.globalCompositeOperation = "source-over"; }
    for (const stroke of next) {
      if (!stroke.points.length) continue;
      const path = new Path2D(); path.moveTo(stroke.points[0].x, stroke.points[0].y); stroke.points.slice(1).forEach((point) => path.lineTo(point.x, point.y));
      octx.save(); octx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over"; octx.globalAlpha = stroke.erase ? 1 : .84; octx.strokeStyle = "#e04439"; octx.fillStyle = "#e04439"; octx.lineWidth = stroke.size; octx.lineCap = "round"; octx.lineJoin = "round"; octx.stroke(path);
      if (stroke.points.length === 1) { octx.beginPath(); octx.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2); octx.fill(); }
      octx.restore();
      mctx.save(); mctx.globalCompositeOperation = stroke.erase ? "source-over" : "destination-out"; mctx.strokeStyle = "white"; mctx.fillStyle = "white"; mctx.lineWidth = stroke.size; mctx.lineCap = "round"; mctx.lineJoin = "round"; mctx.stroke(path);
      if (stroke.points.length === 1) { mctx.beginPath(); mctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2); mctx.fill(); }
      mctx.restore();
    }
    ctx.drawImage(overlay, 0, 0);
    if (cropRect && cropRect.w > 0 && cropRect.h > 0) { ctx.save(); ctx.strokeStyle = "#d45549"; ctx.lineWidth = Math.max(3, width / 360); ctx.setLineDash([12, 8]); ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h); ctx.restore(); }
  }
  function scanSelection(canvas = maskCanvas.current) { if (!canvas) return false; const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data; let selected = false; if (pixels) { for (let index = 3; index < pixels.length; index += 4) { if (pixels[index] < 250) { selected = true; break; } } } setHasSelection(selected); return selected; }
  // draw deliberately closes over the current canvas refs; state changes are the render trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (loaded) draw(strokes, rotation, crop); }, [loaded, strokes, rotation, crop, imageVersion]);
  useEffect(() => { if (loaded) scanSelection(); }, [loaded, selectionScanVersion, imageVersion]);

  function start(event: PointerEvent<HTMLCanvasElement>) { if (saving || !loaded) return; event.currentTarget.setPointerCapture(event.pointerId); const point = canvasPoint(event); if (tool === "crop") { cropStart.current = point; setCrop({ x: point.x, y: point.y, w: 0, h: 0 }); return; } setDrawing(true); setRedo([]); setStrokes((current) => [...current, { points: [point], size, erase: tool === "eraser" }]); }
  function move(event: PointerEvent<HTMLCanvasElement>) { if (saving || !loaded) return; const point = canvasPoint(event); if (tool === "crop" && cropStart.current) { setCrop(rectFromPoints(cropStart.current, point)); return; } if (!drawing) return; setStrokes((current) => { const next = current.slice(); const last = next[next.length - 1]; if (!last) return current; next[next.length - 1] = { ...last, points: [...last.points, point] }; return next; }); }
  function finish() { setDrawing(false); cropStart.current = undefined; setSelectionScanVersion((version) => version + 1); }
  function loadSource(src: string, after?: () => void) { const next = new Image(); next.onload = () => { sourceRef.current = next; baseCanvas.current = undefined; setRotation(0); setCrop(undefined); setLoaded(true); setHasSelection(false); setImageVersion((version) => version + 1); after?.(); }; next.onerror = () => setMessage("无法读取编辑后的图片。"); next.src = src; }
  function applyCrop() { if (hasSelection) { setMessage("请先整理画面再圈选，再进行裁剪。"); return; } const mask = maskCanvas.current; const rect = crop; const base = baseCanvas.current; if (!base || !mask || !rect || rect.w < 2 || rect.h < 2) return; const output = document.createElement("canvas"); output.width = Math.round(rect.w); output.height = Math.round(rect.h); output.getContext("2d")?.drawImage(base, rect.x, rect.y, rect.w, rect.h, 0, 0, output.width, output.height); const croppedMask = document.createElement("canvas"); croppedMask.width = output.width; croppedMask.height = output.height; croppedMask.getContext("2d")?.drawImage(mask, rect.x, rect.y, rect.w, rect.h, 0, 0, croppedMask.width, croppedMask.height); loadSource(output.toDataURL("image/png"), () => { baseCanvas.current = output; setStrokes([]); setRedo([]); setBaseEdited(true); setSelectionScanVersion((version) => version + 1); setMessage("已应用裁剪；请保存编辑底图。"); window.setTimeout(() => { const target = maskCanvas.current; const context = target?.getContext("2d"); if (target && context) { target.width = croppedMask.width; target.height = croppedMask.height; context.drawImage(croppedMask, 0, 0); } }, 0); }); }
  function resetImage() { if (!originalSrc.current) return; initialMaskRef.current = undefined; loadSource(originalSrc.current, () => { setStrokes([]); setRedo([]); setHasSelection(false); setSelectionScanVersion((version) => version + 1); setBaseEdited(false); setCrop(undefined); setMessage("已恢复原始图片。"); }); }
  function rotate(delta: number) { if (strokes.some((stroke) => !stroke.erase)) { setMessage("请先整理画面再圈选，再进行旋转。"); return; } const source = sourceRef.current; if (!source) return; const current = renderBase(source, rotation); const output = document.createElement("canvas"); output.width = current.height; output.height = current.width; const context = output.getContext("2d"); if (!context) return; context.translate(output.width / 2, output.height / 2); context.rotate(delta * Math.PI / 180); context.drawImage(current, -current.width / 2, -current.height / 2); loadSource(output.toDataURL("image/png"), () => { baseCanvas.current = output; setStrokes([]); setRedo([]); setBaseEdited(true); setMessage("已旋转90°；画布已交换宽高且不会截断，请保存编辑底图。"); }); }
  function undo() { const last = strokes[strokes.length - 1]; if (!last) return; setStrokes(strokes.slice(0, -1)); setRedo([...redo, last]); setSelectionScanVersion((version) => version + 1); }
  function redoStroke() { const last = redo[redo.length - 1]; if (!last) return; setRedo(redo.slice(0, -1)); setStrokes([...strokes, last]); setSelectionScanVersion((version) => version + 1); }
  function clearSelection() { initialMaskRef.current = undefined; setStrokes([]); setRedo([]); setHasSelection(false); setSelectionScanVersion((version) => version + 1); setCrop(undefined); setMessage("已清空局部选区。"); }
  async function saveMask() {
    if (onSelectionSaved) {
      if (savingRef.current || !loaded || !hasSelection || !scanSelection()) return;
      const base = baseCanvas.current; const mask = maskCanvas.current; const annotation = previewCanvas.current;
      if (!base || !mask || !annotation) return;
      savingRef.current = true; setSaving(true); setMessage("");
      const exportFile = (canvas: HTMLCanvasElement, name: string) => new Promise<File>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(new File([blob], name, { type: "image/png" })) : reject(new Error("无法导出局部草稿。")), "image/png"));
      try {
        draw(strokes, rotation, null);
        const [baseFile, maskFile, annotationFile] = await Promise.all([exportFile(base, "local-original.png"), exportFile(mask, "local-mask.png"), exportFile(annotation, "local-annotation.png")]);
        if (!alive.current) return;
        await onSelectionSaved({ base: baseFile, mask: maskFile, annotation: annotationFile, width: base.width, height: base.height });
      } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "局部草稿保存失败，原草稿保留。"); }
      finally { savingRef.current = false; if (alive.current) setSaving(false); }
      return;
    }
    const canvas = maskCanvas.current; if (!canvas || (!hasSelection && !baseEdited)) return; setSaving(true); setMessage(""); try { let editedBase: UploadedImage | undefined; if (baseEdited) { const sourceCanvas = baseCanvas.current; if (!sourceCanvas) throw new Error("无法导出编辑底图"); const baseBlob = await new Promise<Blob>((resolve, reject) => sourceCanvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法导出编辑底图")), "image/png")); const file = new File([baseBlob], "edited-base.png", { type: "image/png" }); editedBase = await saveDraftImage("editor:source:base", "source", file, sourceCanvas.width, sourceCanvas.height); } let maskAsset: UploadedImage | undefined; if (hasSelection) { const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data; let transparent = false; if (pixels) { for (let index = 3; index < pixels.length; index += 4) { if (pixels[index] < 250) { transparent = true; break; } } } if (!transparent) throw new Error("当前没有有效透明选区，请用画笔标记区域。"); const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("无法导出蒙版")), "image/png")); const file = new File([blob], "selection-mask.png", { type: "image/png" }); maskAsset = await saveDraftImage("editor:mask", "mask", file, canvas.width, canvas.height); } onMaskSaved?.(maskAsset, editedBase); setMessage(editedBase && maskAsset ? "编辑底图与透明蒙版已保存在当前标签页。" : editedBase ? "编辑底图已保存在当前标签页。" : "透明 Alpha 蒙版已保存在当前标签页。"); } catch (error) { setMessage(error instanceof Error ? error.message : "编辑结果保存失败。"); } finally { setSaving(false); } }
  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) { if (event.key === "Escape") { event.preventDefault(); onClose(); return; } if (event.key !== "Tab" || !dialogRef.current) return; const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')); if (!focusable.length) return; const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }

  const canSave = loaded && (onSelectionSaved ? hasSelection : hasSelection || baseEdited);
  return <div className="studio-editor-backdrop" role="presentation"><section ref={dialogRef} className="studio-image-editor" role="dialog" aria-modal="true" aria-label="局部选区编辑器" onKeyDown={handleKeyDown}>
    <header><div><span className="section-kicker">LOCAL DRAFT</span><h2>局部选区与底图整理</h2><p>{onSelectionSaved ? "圈出需要修改的对象，保存后在局部选区预览。原图与红色标注将在确认生成时一起发送；选区外仍可能变化。" : "红色标记和透明 Alpha 蒙版只保存在当前标签页，尚不会随国内模型任务发送。"}</p></div><button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭编辑器" onClick={onClose}>×</button></header>
    <fieldset disabled={saving} className="editor-toolbar" aria-label="图片编辑工具"><button type="button" aria-pressed={tool === "brush"} className={tool === "brush" ? "selected" : ""} onClick={() => setTool("brush")}>画笔</button><button type="button" aria-pressed={tool === "eraser"} className={tool === "eraser" ? "selected" : ""} onClick={() => setTool("eraser")}>橡皮擦</button><button type="button" aria-pressed={tool === "crop"} className={tool === "crop" ? "selected" : ""} onClick={() => setTool("crop")}>裁剪</button><label>粗细 <input aria-label="画笔粗细" type="range" min="8" max="120" step="4" value={size} onChange={(event) => setSize(Number(event.target.value))} /></label><button type="button" onClick={() => rotate(90)} disabled={hasSelection}>右旋转</button><button type="button" onClick={() => rotate(-90)} disabled={hasSelection}>左旋转</button><button type="button" onClick={applyCrop} disabled={!crop || crop.w < 2 || hasSelection}>应用裁剪</button><button type="button" onClick={resetImage}>重置图片</button><button type="button" onClick={undo} disabled={!strokes.length}>撤销</button><button type="button" onClick={redoStroke} disabled={!redo.length}>重做</button><button type="button" onClick={clearSelection} disabled={!hasSelection && !strokes.length && !crop}>清空选区</button></fieldset>
    <div className="editor-canvas-wrap"><canvas ref={previewCanvas} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} aria-label="图片局部选区画布" /><canvas ref={maskCanvas} className="alpha-mask-canvas" aria-hidden="true" /></div>
    <footer><span className="editor-status" role="status" aria-live="polite">{message || (hasSelection ? "已标记选区，可保存草稿。" : "请用画笔圈选需要修改的区域。")}</span><div><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={!canSave || saving} onClick={() => void saveMask()}>{saving ? "保存中…" : onSelectionSaved ? "保存草稿" : baseEdited && !hasSelection ? "保存编辑底图" : "保存本地蒙版"}</button></div></footer>
  </section></div>;
}
