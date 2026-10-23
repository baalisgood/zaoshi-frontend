"use client";
import { useEffect, useRef, useState } from "react";
import { submitGallerySubmission, type AssetRecord, type GalleryCategory } from "@/components/site/api";

type Props = { asset: AssetRecord; onClose: () => void; onSuccess: () => void };
const consent = "确认拥有展示权，不含真实地址、客户隐私或无权参考素材。撤回只停止后续公开，不能召回已下载副本。";
export function GallerySubmissionDialog({ asset, onClose, onSuccess }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [category, setCategory] = useState<GalleryCategory>("interior");
  const [title, setTitle] = useState(asset.fileName?.replace(/\.[^.]+$/u, "") ?? "");
  const [note, setNote] = useState("");
  const [publicPrompt, setPublicPrompt] = useState("");
  const [promptConsent, setPromptConsent] = useState(false);
  const [imageConsent, setImageConsent] = useState(false);
  const [state, setState] = useState<"idle"|"working"|"success"|"error">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!imageConsent) return; setState("working"); setError(""); try { await submitGallerySubmission({ sourceAssetId: asset.id, category, title: title.trim(), note: note.trim(), publicPrompt: promptConsent ? publicPrompt.trim() : "", imageConsent: "2026-08-28-v1", promptConsent }); setState("success"); onSuccess(); } catch (reason) { setState("error"); setError(reason instanceof Error ? reason.message : "投稿失败，请稍后重试。"); } }
  return <dialog ref={dialogRef} className="gallery-submit-dialog" onCancel={event => { event.preventDefault(); if (state !== "working") onClose(); }}><form onSubmit={submit}><button type="button" className="gallery-detail-close" aria-label="关闭申请展示" onClick={onClose} disabled={state === "working"}>×</button><span className="section-kicker">COMMUNITY GALLERY</span><h2>申请展示</h2>{state === "success" ? <div className="state-panel" role="status"><strong>已提交审核</strong><p>审核通过后会出现在社区精选图库。</p><button type="button" onClick={onClose}>完成</button></div> : <><p>作品将经过审核后公开展示。</p><label>类别<select value={category} onChange={event => setCategory(event.target.value as GalleryCategory)}><option value="interior">室内设计</option><option value="landscape">景观环境</option><option value="architecture">建筑外观</option></select></label><label>标题<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label><label>说明<textarea maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label><label className="checkbox-line"><input type="checkbox" checked={promptConsent} onChange={event => setPromptConsent(event.target.checked)} />公开创作方向（可选）</label>{promptConsent && <label>公开创作方向<textarea maxLength={4000} value={publicPrompt} onChange={event => setPublicPrompt(event.target.value)} /></label>}<label className="checkbox-line"><input required type="checkbox" checked={imageConsent} onChange={event => setImageConsent(event.target.checked)} />我已确认：{consent}</label>{state === "error" && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={!imageConsent || state === "working"}>{state === "working" ? "正在提交…" : "提交审核"}</button></>}</form></dialog>;
}
