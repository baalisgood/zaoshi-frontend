"use client";

import { useEffect, useRef, useState } from "react";
import { loadParameterDraft, saveParameterDraft } from "@/components/studio/browser-drafts";

export type ReferenceHint = { role: string; count: number };
function hints(value: Record<string, unknown>): ReferenceHint[] { return Array.isArray(value.referenceHints) ? value.referenceHints.filter((item): item is ReferenceHint => Boolean(item && typeof item === "object" && typeof (item as ReferenceHint).role === "string" && Number.isInteger((item as ReferenceHint).count))) : []; }

export function useStudioParameterDraft(workflow: string, config: Record<string, unknown>, apply: (config: Record<string, unknown>) => void) {
  const applyRef = useRef(apply);
  const [ready, setReady] = useState(false);
  const [referenceHints, setReferenceHints] = useState<ReferenceHint[]>([]);

  useEffect(() => { applyRef.current = apply; }, [apply]);

  useEffect(() => {
    let active = true;
    const saved = loadParameterDraft(workflow);
    if (saved) applyRef.current(saved);
    const restore = (event: Event) => {
      const detail = (event as CustomEvent<{ workflowType?: string; config?: Record<string, unknown> }>).detail;
      if (detail?.workflowType !== workflow || !detail.config) return;
      applyRef.current(detail.config);
      setReferenceHints(hints(detail.config));
    };
    window.addEventListener("zaoshi:apply-job-parameters", restore);
    queueMicrotask(() => { if (active) { if (saved) setReferenceHints(hints(saved)); setReady(true); } });
    return () => { active = false; window.removeEventListener("zaoshi:apply-job-parameters", restore); };
  }, [workflow]);

  useEffect(() => { if (ready) saveParameterDraft(workflow, config); }, [config, ready, workflow]);
  return referenceHints;
}
