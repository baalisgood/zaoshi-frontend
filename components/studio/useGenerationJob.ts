"use client";

import { loadSession, requireClientAccess } from "@/components/site/session";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGeneration, finalizeGeneration, JobSnapshot, shouldPollReconciliation } from "@/components/site/api";
import { submitGenerationDraft } from "@/components/studio/browser-drafts";

const terminalStatuses = new Set(["SUCCEEDED", "PARTIAL_SUCCEEDED", "FAILED", "CANCELED"]);
export function chooseFinalizeAttemptKey(baseKey: string, lastBaseKey: string | undefined, lastAttemptKey: string | undefined, confirmedFailure: boolean): string { if (confirmedFailure) return crypto.randomUUID(); if (lastBaseKey === baseKey && lastAttemptKey) return lastAttemptKey; return baseKey; }

export type GenerationController = {
  job: JobSnapshot | null;
  busy: boolean;
  submitting: boolean;
  pollingLost: boolean;
  submit: (payload: Record<string, unknown>) => Promise<void>;
  finalize: (payload: Record<string, unknown>) => Promise<void>;
  retry: () => Promise<void>;
  reset: () => void;
  finalizeError?: string;
};

export function useGenerationJob(privateTest: boolean | undefined): GenerationController {
  const privateTestMode = useRef(privateTest);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [pollingLost, setPollingLost] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationEpoch = useRef(0);
  const active = useRef(true);
  const inFlight = useRef(false);
  const submitInFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const promotionPreview = useRef<JobSnapshot | null>(null);
  const confirmedFinalFailure = useRef(false);
  const lastFinalizeBaseKey = useRef<string | undefined>(undefined);
  const lastFinalizeAttemptKey = useRef<string | undefined>(undefined);
  const [finalizeError, setFinalizeError] = useState<string>();

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => { privateTestMode.current = privateTest; }, [privateTest]);

  const poll = useCallback(async (id: string, epoch = generationEpoch.current): Promise<void> => {
    try {
      const snapshot = await fetchGeneration(id);
      if (!active.current || epoch !== generationEpoch.current) return;
      setPollingLost(false);
      if ((snapshot.status === "SUCCEEDED" || snapshot.status === "PARTIAL_SUCCEEDED") && snapshot.results.length === 0) {
        setJob({ ...snapshot, status: "FAILED", message: "任务已结束，但没有返回可展示的图片。" });
        return;
      }
      if ((snapshot.status === "SUCCEEDED" || snapshot.status === "PARTIAL_SUCCEEDED") && promotionPreview.current) { promotionPreview.current = null; confirmedFinalFailure.current = false; lastFinalizeBaseKey.current = undefined; lastFinalizeAttemptKey.current = undefined; setFinalizeError(undefined); }
      setJob(snapshot);
      if (terminalStatuses.has(snapshot.status)) void loadSession(true).catch(() => undefined);
      if ((snapshot.status === "FAILED" || snapshot.status === "CANCELED") && promotionPreview.current) { const preview = promotionPreview.current; promotionPreview.current = null; confirmedFinalFailure.current = true; setFinalizeError(snapshot.message ?? "高清成品任务失败，请重试。"); setJob({ ...preview, message: snapshot.message ?? "高清成品任务失败，请重试。" }); return; }
      if (shouldPollReconciliation(snapshot, privateTestMode.current) && !terminalStatuses.has(snapshot.status)) {
        timer.current = setTimeout(() => void poll(id, epoch), 1800);
      }
    } catch (error) {
      if (!active.current || epoch !== generationEpoch.current) return;
      setPollingLost(true);
      setJob((current) => ({
        ...(current ?? { status: "POLLING_FAILED", results: [] }),
        id,
        status: "POLLING_FAILED",
        message: error instanceof Error ? error.message : "任务状态暂时无法获取。",
      }));
    }
  }, []);

  const submit = useCallback(async (payload: Record<string, unknown>): Promise<void> => {
    if (!requireClientAccess() || submitInFlight.current) return;
    submitInFlight.current = true;
    setSubmitting(true);
    const epoch = ++generationEpoch.current;
    if (timer.current) clearTimeout(timer.current);
    setPollingLost(false);
    setFinalizeError(undefined); promotionPreview.current = null;
    confirmedFinalFailure.current = false;
    lastFinalizeBaseKey.current = undefined; lastFinalizeAttemptKey.current = undefined;
    setJob({ status: "SUBMITTING", results: [], message: "正在提交任务…" });
    try {
      const snapshot = await submitGenerationDraft(payload);
      void loadSession(true).catch(() => undefined);
      if (!active.current || epoch !== generationEpoch.current) return;
      window.dispatchEvent(new Event("zaoshi:jobs-changed"));
      setJob(snapshot);
      if (!snapshot.id) {
        setJob({ ...snapshot, status: "FAILED", message: "任务已返回，但缺少可查询的任务编号。" });
        return;
      }
      void poll(snapshot.id, epoch);
    } catch (error) {
      if (!active.current || epoch !== generationEpoch.current) return;
      setJob({
        status: "FAILED",
        results: [],
        message: error instanceof Error ? error.message : "生成任务未能提交。",
      });
    } finally {
      submitInFlight.current = false;
      if (active.current) setSubmitting(false);
    }
  }, [poll]);
  const finalize = useCallback(async (payload: Record<string, unknown>): Promise<void> => {
    if (!job?.id || inFlight.current) return;
    const epoch = ++generationEpoch.current;
    const previewSnapshot = job;
    inFlight.current = true;
    promotionPreview.current = previewSnapshot;
    const baseKey = String(payload.idempotencyKey ?? "");
    const attemptKey = chooseFinalizeAttemptKey(baseKey, lastFinalizeBaseKey.current, lastFinalizeAttemptKey.current, confirmedFinalFailure.current);
    lastFinalizeBaseKey.current = baseKey; lastFinalizeAttemptKey.current = attemptKey;
    const effectivePayload = { ...payload, idempotencyKey: attemptKey };
    if (timer.current) clearTimeout(timer.current);
    setJob({ ...job, status: "SUBMITTING", results: [], message: "正在提交高清成品任务…" });
    try { const snapshot = await finalizeGeneration(job.id, effectivePayload); if (!active.current || epoch !== generationEpoch.current) return; setJob(snapshot); if (snapshot.id) await poll(snapshot.id, epoch); }
    catch (error) { if (epoch !== generationEpoch.current) return; promotionPreview.current = null; confirmedFinalFailure.current = false; if (active.current) { setFinalizeError(error instanceof Error ? error.message : "高清成品任务未能提交。"); setJob({ ...job, message: `高清成品任务失败：${error instanceof Error ? error.message : "请稍后重试"}。参考图仍可再次尝试。` }); } } finally { inFlight.current = false; }
  }, [job, poll]);

  const retry = useCallback(async () => {
    if (job?.id) await poll(job.id, generationEpoch.current);
  }, [job?.id, poll]);

  const reset = useCallback(() => {
    generationEpoch.current += 1;
    if (timer.current) clearTimeout(timer.current);
    setPollingLost(false);
    setFinalizeError(undefined); promotionPreview.current = null;
    confirmedFinalFailure.current = false; lastFinalizeBaseKey.current = undefined; lastFinalizeAttemptKey.current = undefined;
    setJob(null);
  }, []);

  return {
    job,
    busy: Boolean(job && shouldPollReconciliation(job, privateTest) && ["SUBMITTING", "QUEUED", "PREPROCESSING", "GENERATING", "VALIDATING"].includes(job.status)),
    submitting,
    pollingLost,
    finalizeError,
    submit,
    finalize,
    retry,
    reset,
  };
}
