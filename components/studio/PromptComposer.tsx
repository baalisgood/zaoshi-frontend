"use client";
/* eslint-disable react-hooks/set-state-in-effect -- reconcile external draft/mode and owner-scoped sessionStorage without changing the draft. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadSession, useSession } from "@/components/site/session";
import { optimizeImagePrompt, quoteImagePrompt, readPromptOptimization, PromptOptimizationError, type PromptOptimizationContext, type PromptOptimizationQuote, type PromptOptimizationResult } from "@/components/site/api";

type Receipt = { quoteId: string; context: PromptOptimizationContext; fingerprint: string; result?: string; charge?: number };
export async function optimizeCurrentPrompt(prompt: string, isCurrent: () => boolean, quoteId: string, context: PromptOptimizationContext = "ordinary") {
  const result = await optimizeImagePrompt(prompt.trim(), quoteId, context);
  return isCurrent() ? result : undefined;
}
async function fingerprint(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2,"0")).join(""); }
export function PromptComposer({ id, label = "创作要求", value, onChange, privateTest, disabled = false, context = "ordinary", contextKey = "" }: { id: string; label?: string; value: string; onChange: (value: string) => void; privateTest?: boolean; disabled?: boolean; context?: PromptOptimizationContext; contextKey?: string }) {
  const session = useSession();
  const storageKey = session?.draftScope ? `zaoshi:optimization:${session.draftScope}:${id}` : undefined;
  const scopeRef = useRef(storageKey); const restoredScope = useRef<string | undefined>(undefined);
  useLayoutEffect(() => { if (storageKey) scopeRef.current = storageKey; }, [storageKey]);
  const [message, setMessage] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [quote, setQuote] = useState<PromptOptimizationQuote>();
  const [receipt, setReceipt] = useState<Receipt>();
  const receiptRef = useRef(receipt);
  const [before, setBefore] = useState<{ original: string; optimized: string }>();
  const current = useRef(value); const version = useRef(0); const active = useRef(true); const loading = useRef(false);
  const mode = `${disabled}:${context}:${contextKey}`; const previousMode = useRef(mode);
  useLayoutEffect(() => { if (current.current !== value || previousMode.current !== mode) version.current += 1; current.current = value; previousMode.current = mode; }, [value, mode]);
  useEffect(() => { setQuote(undefined); setBefore((previous) => previous?.optimized === value ? previous : undefined); }, [value, mode]);
  useEffect(() => { active.current = true; return () => { active.current = false; version.current += 1; }; }, []);
  useLayoutEffect(() => {
    if (!storageKey || restoredScope.current === storageKey) return;
    restoredScope.current = storageKey;
    receiptRef.current = undefined; setReceipt(undefined); setBefore(undefined); setQuote(undefined); setMessage(""); version.current += 1;
    try { const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null"); if (typeof saved?.quoteId === "string" && /^optimization_[a-f0-9-]{36}$/u.test(saved.quoteId) && (saved.context === "ordinary" || saved.context === "local-prompt") && typeof saved.fingerprint === "string") { receiptRef.current = saved; setReceipt(saved); } } catch { /* Storage unavailable: dispatch will fail before charging. */ }
  }, [storageKey]);
  function remember(next?: Receipt) {
    if (!storageKey) throw new Error("正在确认账户，请稍后再试。");
    if (next) sessionStorage.setItem(storageKey, JSON.stringify({ quoteId: next.quoteId, context: next.context, fingerprint: next.fingerprint })); else sessionStorage.removeItem(storageKey);
    receiptRef.current = next; setReceipt(next);
  }
  function finish(result: PromptOptimizationResult, pending: Receipt, original?: string, started?: number) {
    if (!active.current) return;
    if (result.status === "DISPATCHING") { setMessage("请求正在处理中；可查询同一请求的结果。"); return; }
    const completed = { ...pending, result: result.optimizedPrompt, charge: result.chargedCredits };
    receiptRef.current = completed; setReceipt(completed); setQuote(undefined);
    if (original !== undefined && version.current === started && current.current === original) { setBefore({ original, optimized: result.optimizedPrompt }); current.current = result.optimizedPrompt; onChange(result.optimizedPrompt); }
    setMessage(`提示词已优化，本次扣除 ${result.chargedCredits} 积分。`);
  }
  async function optimize() {
    if (disabled || !value.trim() || value.length > 2000 || loading.current || privateTest === undefined || !storageKey) return;
    if (receiptRef.current && !receiptRef.current.result) { await recoverReceipt(receiptRef.current); return; }
    const started = version.current; const original = value; const ownerScope = storageKey;
    const isCurrent = () => active.current && version.current === started && current.current === original;
    loading.current = true; setOptimizing(true); setMessage(quote ? "正在优化提示词…" : "正在获取费用上限…");
    try {
      if (!quote) { const next = await quoteImagePrompt(original.trim(), context); if (isCurrent()) { setQuote(next); setMessage(""); } return; }
      const pending = { quoteId: quote.quoteId, context, fingerprint: await fingerprint(`${context}:${original.trim()}`) };
      if (!isCurrent()) return;
      remember(pending);
      const result = await optimizeImagePrompt(original.trim(), pending.quoteId, context);
      if (ownerScope === scopeRef.current && active.current) finish(result, pending, original, started);
      void loadSession(true).catch(() => undefined);
    } catch (error) {
      if (scopeRef.current !== ownerScope) return;
      if (error instanceof PromptOptimizationError && error.terminal) { try { remember(); } catch { /* The persisted handle can still be queried safely. */ } setQuote(undefined); }
      if (active.current) setMessage(error instanceof Error ? error.message : "结果暂未确认；可查询同一请求，避免重复提交。");
      void loadSession(true).catch(() => undefined);
    } finally { loading.current = false; if (active.current) setOptimizing(false); }
  }
  async function recoverReceipt(pending: Receipt) {
    if (disabled || loading.current) return;
    const ownerScope = scopeRef.current;
    loading.current = true; setOptimizing(true);
    try {
      const result = await readPromptOptimization(pending.quoteId);
      if (!active.current || scopeRef.current !== ownerScope) return;
      if (result.status === "FAILED" || result.status === "QUOTED") { remember(); setQuote(undefined); setMessage(result.status === "FAILED" ? "本次优化未完成，不扣费。" : "本次优化尚未提交，未扣费；可重新获取报价。"); }
      else finish(result, pending);
      void loadSession(true).catch(() => undefined);
    } catch (error) { if (active.current) setMessage(error instanceof Error ? error.message : "暂时无法查询，请稍后再试。"); }
    finally { loading.current = false; if (active.current) setOptimizing(false); }
  }
  function change(next: string) { version.current += 1; current.current = next; onChange(next); setBefore(undefined); setQuote(undefined); setMessage(""); }
  return <section className="studio-panel self-prompt-panel" data-disabled={disabled}><div className="panel-heading"><span>02</span><div><h2>提示词</h2><p>{disabled ? "选择「提示词修改」后可编辑；已有文字保留。" : context === "local-prompt" ? "说明选区内要修改的内容，保留选区外的空间。" : "说明空间、材质、家具、灯光或希望修改的内容。"}</p></div></div><label className="prompt-field" htmlFor={id}><span>{label}</span><textarea id={id} disabled={disabled || optimizing} required={context === "local-prompt" && !disabled} value={value} maxLength={2000} placeholder="例如：保留原有空间结构，把客厅改成温暖克制的现代住宅，使用浅木、米白织物和柔和间接照明……" onChange={(event) => change(event.target.value)} /></label><div className="prompt-actions"><button className="secondary-button" type="button" disabled={disabled || !value.trim() || value.length > 2000 || optimizing || privateTest === undefined || !storageKey || Boolean(quote && quote.availableCredits < quote.maximumCredits)} onClick={() => void optimize()}>{optimizing ? "正在处理…" : quote ? `确认优化 · 最多 ${quote.maximumCredits} 积分` : "AI 优化提示词"}</button>{quote && <button type="button" className="text-button" disabled={disabled || optimizing} onClick={() => { setQuote(undefined); setMessage(""); }}>取消</button>}{before !== undefined && value === before.optimized && <button className="text-button" type="button" disabled={disabled || optimizing} onClick={() => { change(before.original); setMessage("已恢复优化前的提示词，已完成优化的费用不退回。"); }}>撤销优化</button>}<span>{value.trim().length}/2000</span></div>{quote && <p className="summary-note" role="note">预计最多 {quote.maximumCredits} 积分，成功后按实际输入量结算，失败不扣费。按输入 token 官方费用 ×3 计价，100 积分/元，向上取整，最低 1 积分。{quote.availableCredits < quote.maximumCredits ? "可用积分不足，请先充值。" : ""}</p>}{receipt && !receipt.result && <p className="summary-note"><button className="text-button" type="button" disabled={disabled || optimizing} onClick={() => void recoverReceipt(receipt)}>查询已提交的优化</button></p>}{receipt?.result && value !== receipt.result && <div className="summary-note" role="status"><p>已完成的优化 · {receipt.charge} 积分 · {receipt.context === "local-prompt" ? "局部提示词" : "创作提示词"}</p><p>{receipt.result}</p></div>}{message && <p className="summary-note" role="status">{message}</p>}</section>;
}
