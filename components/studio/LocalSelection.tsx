"use client";
/* eslint-disable @next/next/no-img-element -- user-owned local Blob previews cannot use a server image optimizer. */
import { useEffect, useId, useRef, useState } from "react";
import { ImageUploadField, type UploadedImage } from "./StudioFields";
import { captureDraftSession, loadDraftImage, loadParameterDraft, removeDraftImage, saveDraftImage, saveParameterDraft } from "./browser-drafts";
import { createUploadAdmission, summarizeGenerationInputs } from "./input-limits";
import { imageModelCapabilities, type ImageModel } from "@/lib/domain/image-models";
import { localEditOptions, type LocalEditOperation } from "@/lib/domain/local-edit";

export type SelectionFiles = { base: File; mask: File; annotation: File; width: number; height: number };
type Bundle = { id: string; base: UploadedImage; mask: UploadedImage; annotation: UploadedImage };
const draftKey = "advanced:local-edit";
const imageKeys = (id: string) => ["base", "mask", "annotation"].map((part) => `${draftKey}:${id}:${part}`);
async function removeBundle(id: string) { await Promise.allSettled(imageKeys(id).map(removeDraftImage)); }

export function useLocalSelection() {
  const [draft, setDraft] = useState<Bundle>();
  const [enabled, setEnabled] = useState(false);
  const [operation, setOperation] = useState<LocalEditOperation>("replace");
  const [slots, setSlots] = useState(0);
  const [references, setReferences] = useState<(UploadedImage | undefined)[]>([]);
  const [states, setStates] = useState<Record<number, string>>({});
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ image: UploadedImage; mask?: UploadedImage; token: number }>();
  const generation = useRef(0);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => {
    mounted.current = true;
    let active = true; const sessionCurrent = captureDraftSession();
    const cleared = () => { active = false; generation.current++; draftRef.current = undefined; setDraft(undefined); setEnabled(false); setReferences([]); setSlots(0); setStates({}); setEditor(undefined); setReady(true); setNotice("账号草稿已清除，请重新选择图片。"); };
    window.addEventListener("zaoshi:drafts-cleared", cleared);
    const saved = loadParameterDraft(draftKey);
    void (async () => {
      try {
        const op = localEditOptions.find((option) => option.value === saved?.operation)?.value ?? "replace";
        const count = typeof saved?.slots === "number" && Number.isInteger(saved.slots) ? Math.max(0, Math.min(3, saved.slots)) : 0;
        let restored: Bundle | undefined;
        if (saved?.bundleId) {
          if (saved.version !== 1 || typeof saved.bundleId !== "string" || !/^[a-f0-9-]{36}$/u.test(saved.bundleId)) throw new Error("局部草稿记录无效，请重新圈选。");
          const [base, mask, annotation] = await Promise.all(imageKeys(saved.bundleId).map(loadDraftImage));
          if (!base || !mask || !annotation || !base.width || !base.height || [mask, annotation].some((image) => image.width !== base.width || image.height !== base.height)) throw new Error("局部草稿已过期或不完整，请重新圈选。");
          restored = { id: saved.bundleId, base, mask, annotation };
        }
        const restoredReferences = await Promise.all(Array.from({ length: count }, (_, index) => loadDraftImage(`${window.location.pathname}:advanced:local-reference:${index}`)));
        if (!active || !sessionCurrent()) return;
        draftRef.current = restored; setDraft(restored); setReferences(restoredReferences); setOperation(op); setSlots(count); setEnabled(Boolean(restored && saved?.enabled));
      } catch (error) { if (active) setNotice(error instanceof Error ? error.message : "无法恢复局部草稿。"); }
      finally { if (active) setReady(true); }
    })();
    return () => { active = false; mounted.current = false; window.removeEventListener("zaoshi:drafts-cleared", cleared); };
  }, []);
  function persist(next: { draft?: Bundle; enabled: boolean; operation: LocalEditOperation; slots: number }) {
    saveParameterDraft(draftKey, { version: 1, bundleId: next.draft?.id, enabled: next.enabled, operation: next.operation, slots: next.slots });
  }
  function update(next: { enabled?: boolean; operation?: LocalEditOperation; slots?: number }) {
    const value = { draft, enabled, operation, slots, ...next };
    try { persist(value); setEnabled(value.enabled && Boolean(draft)); setOperation(value.operation); setSlots(value.slots); setNotice(""); }
    catch { setNotice("浏览器草稿存储不可用，设置未更改。"); }
  }
  function open(image?: UploadedImage, resume = true) {
    const base = resume && draft ? draft.base : image;
    if (!base || !ready) return;
    const token = ++generation.current;
    setEditor({ image: base, mask: resume ? draft?.mask : undefined, token });
  }
  function close() { generation.current++; setEditor(undefined); }
  async function save(files: SelectionFiles, token: number) {
    const sessionCurrent = captureDraftSession();
    const allowed = () => mounted.current && generation.current === token && sessionCurrent();
    if (!allowed()) throw new Error("编辑已取消，原草稿仍保留。");
    const id = crypto.randomUUID(); const keys = imageKeys(id); const previous = draftRef.current;
    try {
      const base = await saveDraftImage(keys[0], "source", files.base, files.width, files.height, undefined, allowed);
      const mask = await saveDraftImage(keys[1], "mask", files.mask, files.width, files.height, undefined, allowed);
      const annotation = await saveDraftImage(keys[2], "reference", files.annotation, files.width, files.height, undefined, allowed);
      if (!allowed()) throw new Error("编辑已取消，原草稿仍保留。");
      const next = { id, base, mask, annotation };
      persist({ draft: next, enabled: true, operation, slots });
      generation.current++; draftRef.current = next; setDraft(next); setEnabled(true); setEditor(undefined); setNotice("局部草稿已保存，下方预览即为本次修改区域。");
      if (previous) void removeBundle(previous.id);
    } catch (error) { await removeBundle(id); throw error; }
  }
  async function remove() {
    try {
      persist({ enabled: false, operation, slots });
      generation.current++; setEditor(undefined); setEnabled(false); setDraft(undefined);
      const previous = draftRef.current; draftRef.current = undefined;
      if (previous) await removeBundle(previous.id);
      if (mounted.current) setNotice("已移除局部草稿，恢复常规设计参数。");
    } catch { setNotice("无法移除局部草稿，请检查浏览器存储后重试。"); }
  }
  return { draft, enabled: enabled && Boolean(draft), operation, slots, references, ready, notice, editor, open, close, save, remove, update,
    blocked: !ready || Object.values(states).some((state) => state === "uploading" || state === "error"),
    setReference: (index: number, image?: UploadedImage) => setReferences((current) => { const next = [...current]; next[index] = image; return next; }),
    setState: (index: number, state: string) => setStates((current) => current[index] === state ? current : { ...current, [index]: state }),
  };
}

export function LocalSelectionPanel({ local, source, model }: { local: ReturnType<typeof useLocalSelection>; source?: UploadedImage; model: ImageModel }) {
  const [admission] = useState(() => createUploadAdmission());
  const [demoPlaying, setDemoPlaying] = useState(false);
  const demoClipId = useId();
  const sofaOutline = "M48 436 Q45 389 78 364 Q113 340 171 336 Q235 330 301 336 Q359 336 385 355 Q399 372 396 389 Q423 388 421 413 L414 439 Q365 442 319 469 Q282 492 268 531 L257 559 Q225 577 157 568 L69 558 Q46 551 47 526 Z";
  const inputs = summarizeGenerationInputs(model, { source: local.draft?.base, additionalReferences: [local.draft?.annotation, ...local.references] });
  const maxReferences = Math.min(3, Math.max(0, imageModelCapabilities[model].maxInputImages - 2));
  admission.update(model, inputs.count, (local.draft ? 0 : 2), inputs.bytes, !inputs.allowed);
  return <section className="local-selection" aria-label="局部重绘">
    <div className="selection-entry">
      <div className="selection-example">{local.draft ? <img className="local-selection-preview" src={local.draft.annotation.url} alt="已保存的局部编辑草稿，红色标记为修改区域" /> : <button type="button" className={`selection-sofa-example${demoPlaying ? " is-playing" : ""}`} onClick={() => setDemoPlaying((playing) => !playing)} onPointerLeave={(event) => { if (event.pointerType !== "touch") setDemoPlaying(false); }} onBlur={() => setDemoPlaying(false)} aria-label="预览局部重绘示意：圈选浅色沙发并替换为深绿色沙发">
        <svg viewBox="0 0 900 675" aria-hidden="true">
          <defs><clipPath id={demoClipId}><path d="M36 390 Q39 364 70 352 Q170 329 285 328 Q339 329 361 344 L414 350 L422 412 L414 439 Q354 450 338 479 Q330 513 324 555 L257 559 Q225 577 157 568 L43 558 Z" /></clipPath></defs>
          <image href="/style-previews/french-modern.webp" width="900" height="675" />
          <image className="selection-sofa-after" href="/style-previews/french-modern-sofa-green.webp" width="900" height="675" clipPath={`url(#${demoClipId})`} />
          <path className="selection-sofa-outline" d={sofaOutline} pathLength="1" fill="#ef5965" stroke="#ef5965" strokeWidth="2.5" strokeLinejoin="round" />
          <g className="selection-sofa-brush" style={{ offsetPath: `path("${sofaOutline}")` }}><path d="M0 0 Q-2 -14 8 -15 L17 -7 Q13 2 0 0Z" fill="#ef5965" stroke="white" strokeWidth="2" /><path d="M9 -15 L29 -40 Q33 -44 37 -40 Q41 -37 37 -33 L17 -7Z" fill="#243c32" stroke="white" strokeWidth="3" /></g>
        </svg><span>圈选沙发 · 预览替换效果</span>
      </button>}<small>{local.draft ? "已保存的标注草稿" : "示意图 · 保存后替换为你的标注图"}</small></div>
      <div className="local-selection-details"><div className="selection-entry-copy"><strong>局部重绘</strong><p>圈出要修改的家具或表面，保存后在左侧预览。原图与标注独立保留，移除上方参考图不会清除草稿。</p><p>标注帮助模型识别修改位置，选区外仍可能变化。</p></div>      <div className="local-selection-actions"><button type="button" className="secondary-button" disabled={!local.ready || (!source && !local.draft)} onClick={() => local.open(source)}>{local.draft ? "继续编辑选区" : "编辑选区"}</button><button type="button" className="secondary-button" disabled={!local.draft} aria-pressed={local.enabled} onClick={() => local.update({ enabled: !local.enabled })}>{local.enabled ? "退出局部编辑" : "使用局部编辑"}</button>{local.draft && <button type="button" className="text-button" onClick={() => void local.remove()}>移除局部草稿</button>}</div>
    </div></div>
    <div className="reference-slot-heading"><div><strong>局部参考图</strong><small>家具、颜色或材质 · 当前模型最多 {maxReferences} 张 · 仅局部编辑时参与生成</small></div><button type="button" className="text-button" disabled={!local.enabled || local.slots >= 3} onClick={() => local.update({ slots: local.slots + 1 })}>＋添加局部参考图</button></div>
    <div className="local-reference-grid">{Array.from({ length: local.slots }, (_, index) => <ImageUploadField key={index} compact draftKey={`advanced:local-reference:${index}`} title={`局部参考 ${index + 1}`} hint="家具、颜色或材质图片" kind="reference" model={model} value={local.references[index]} onChange={(image) => local.setReference(index, image)} onStateChange={(state) => local.setState(index, state)} participationStatus={local.enabled ? "参与本次生成" : "当前未启用局部编辑"} uploadGate={local.enabled ? admission.field(`local-${index}`, Boolean(local.references[index]), false, false, local.references[index]?.byteSize ?? 0) : { disabledReason: "请先启用局部编辑。", begin: () => false, complete: () => false, finish: () => undefined, settle: () => undefined }} />)}</div>
    {local.enabled && !inputs.allowed && <p className="error-text" role="alert">局部原图、标注与参考超出当前模型限制；请减少参考图或更换模型，草稿不会被删除。</p>}
    {local.notice && <p className="summary-note" role="status">{local.notice}</p>}
  </section>;
}
