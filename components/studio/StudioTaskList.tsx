"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JobSnapshot, listGenerationJobs, shouldPollReconciliation } from "@/components/site/api";
import { TaskRequestCoordinator, type TaskLoadMode } from "@/components/studio/task-request-coordinator";
import { usePrivateTestMode } from "@/components/studio/StudioFields";

type WorkflowType = "concept" | "advanced" | "floorplan" | "self-service";

const activeStatuses = new Set(["SUBMITTING", "QUEUED", "PREPROCESSING", "GENERATING", "VALIDATING"]);
const statusLabels: Record<string, string> = {
  SUBMITTING: "提交中",
  QUEUED: "排队中",
  PREPROCESSING: "预处理中",
  GENERATING: "生成中",
  VALIDATING: "校验中",
  SUCCEEDED: "已完成",
  PARTIAL_SUCCEEDED: "部分完成",
  FAILED: "失败",
  CANCELED: "已取消",
};

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function sourceUrl(job: JobSnapshot) {
  const assetId = job.sourceAssetId ?? job.additionalReferences?.find((reference) => reference.role === "reference")?.assetId;
  return assetId ? `/api/assets/${encodeURIComponent(assetId)}?content=1` : undefined;
}

function triggerDownload(url: string, index: number) {
  window.setTimeout(() => {
    const anchor = document.createElement("a");
    anchor.href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
    anchor.download = "";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }, index * 120);
}

export function parameterConfig(job: JobSnapshot): Record<string, unknown> {
  const roleCounts = new Map<string, number>();
  if (job.sourceAssetId) roleCounts.set("source", 1);
  if (job.referenceAssetId) roleCounts.set("reference", 1);
  for (const reference of job.additionalReferences ?? []) if (reference.role !== "selection") roleCounts.set(reference.role, (roleCounts.get(reference.role) ?? 0) + 1);
  if (job.depthAssetId) roleCounts.set("depth", 1);
  if (job.normalAssetId) roleCounts.set("normal", 1);
  return Object.fromEntries(Object.entries({
    providerPreference: job.providerPreference ?? job.model,
    stylePresetId: job.workflowType === "concept" ? job.stylePresetId : undefined,
    designSchemeId: job.workflowType === "concept" ? job.designSchemeId ?? undefined : undefined,
    spaceType: job.spaceType && job.spaceType !== "unspecified" ? job.spaceType : undefined,
    lightingPreset: job.lightingPreset,
    preservationMode: job.preservationMode,
    preservation: job.preservationMode,
    controlMode: job.normalAssetId ? "depth-normal" : job.depthAssetId ? "depth" : "none",
    resolution: job.resolution,
    aspectRatio: job.aspectRatio,
    quality: job.quality,
    visualRealism: job.visualRealism,
    lampState: job.lampState,
    colorTemperatureKelvin: job.colorTemperatureKelvin,
    outputCount: job.outputCount,
    ...(job.workflowType === "advanced" && job.advancedSettings !== undefined ? { advancedSettings: job.advancedSettings } : {}),
    customPrompt: (job.workflowType === "advanced" || job.workflowType === "self-service") && job.customPrompt ? job.customPrompt : undefined,
    referenceHints: [...roleCounts].map(([role, count]) => ({ role, count })),
  }).filter(([, value]) => value !== undefined));
}

function inputImageCount(job: JobSnapshot): number { return (job.sourceAssetId ? 1 : 0) + (job.referenceAssetId ? 1 : 0) + (job.depthAssetId ? 1 : 0) + (job.normalAssetId ? 1 : 0) + (job.additionalReferences?.length ?? 0); }

export function StudioTaskList({ workflowType, refreshKey = "" }: { workflowType: WorkflowType; refreshKey?: string }) {
  const privateTest = usePrivateTestMode();
  const historical = workflowType === "floorplan";
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewDialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const requestCoordinator = useRef(new TaskRequestCoordinator());
  const abortController = useRef<AbortController | undefined>(undefined);
  const nextCursorRef = useRef<string | undefined>(undefined);
  const loadRef = useRef<(mode?: TaskLoadMode) => Promise<void>>(async () => undefined);

  const load = useCallback(async (mode: TaskLoadMode = "replace") => {
    const token = requestCoordinator.current.begin(mode);
    if (token === null) return;
    const controller = new AbortController();
    abortController.current = controller;
    try {
      const page = await listGenerationJobs(workflowType, 20, mode === "append" ? nextCursorRef.current : undefined, controller.signal);
      if (!mounted.current || !requestCoordinator.current.isCurrent(token)) return;
      setJobs((current) => {
        const knownIds = new Set(page.jobs.flatMap((job) => job.id ? [job.id] : []));
        const merged = mode === "append"
          ? [...current, ...page.jobs.filter((job) => !current.some((item) => item.id === job.id))]
          : [...page.jobs, ...(current.length > 20 ? current.filter((job) => !job.id || !knownIds.has(job.id)) : [])];
        return merged;
      });
      if (mode === "append" || nextCursorRef.current === undefined) {
        nextCursorRef.current = page.nextCursor;
        setNextCursor(page.nextCursor);
      }
      setState("ready");
      setMessage("");
    } catch (error) {
      if (!mounted.current || !requestCoordinator.current.isCurrent(token) || controller.signal.aborted) return;
      setState("error");
      setMessage(error instanceof Error ? error.message : "任务列表暂时不可用。");
    } finally {
      const wasCurrent = requestCoordinator.current.isCurrent(token);
      const replayRefresh = requestCoordinator.current.finish(token);
      if (wasCurrent) abortController.current = undefined;
      if (replayRefresh && mounted.current) {
        window.setTimeout(() => void loadRef.current("replace"), 0);
      }
    }
  }, [workflowType]);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    const coordinator = requestCoordinator.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      coordinator.cancel();
      abortController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load("replace"), 0);
    return () => { window.clearTimeout(timer); };
    // refreshKey intentionally restarts the first page after a new submission.
  }, [workflowType, refreshKey, load]);

  const hasActiveJobs = jobs.some((job) => shouldPollReconciliation(job, privateTest) && activeStatuses.has(job.status));
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load("replace"); };
    window.addEventListener("zaoshi:jobs-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = hasActiveJobs ? window.setInterval(refresh, 4_000) : undefined;
    return () => {
      window.removeEventListener("zaoshi:jobs-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
      if (timer) window.clearInterval(timer);
    };
  }, [hasActiveJobs, load]);

  const selectableIds = useMemo(() => jobs.flatMap((job) => job.id ? [job.id] : []), [jobs]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const selectedResults = jobs
    .filter((job) => job.id && selected.has(job.id))
    .flatMap((job) => job.results);

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  }

  function toggleOne(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function downloadSelected() {
    if (!selectedResults.length) {
      setMessage("选中的任务还没有可下载图片。");
      return;
    }
    selectedResults.forEach((result, index) => { if (result.url) triggerDownload(result.url, index); });
    setMessage(`已请求下载 ${selectedResults.filter((result) => result.url).length} 张图片；浏览器可能会询问是否允许多文件下载。`);
  }

  function applyParameters(job: JobSnapshot) {
    window.dispatchEvent(new CustomEvent("zaoshi:apply-job-parameters", { detail: { workflowType, config: parameterConfig(job) } }));
    setMessage("已恢复这条任务的参数；参考图片不会被恢复，请按绿色提示重新选择。");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openPreview(url: string, label: string) {
    setPreviewFailed(false);
    setPreview({ url, label });
    previewDialog.current?.showModal();
  }

  return (
    <section className="task-list-panel" aria-labelledby={`${workflowType}-task-list-title`}>
      <div className="task-list-heading">
        <div>
          <span className="section-kicker">TASK QUEUE</span>
          <h2 id={`${workflowType}-task-list-title`}>{historical ? "历史平面任务" : "任务列表"}</h2>
          <p>{historical ? "保留原平面工作台的任务和图片，可查看与下载。新需求请在上方自助工作台提交。" : "显示本工作台当前账号提交的任务；生成期间可继续提交下一项。"}</p>
        </div>
        <div className="task-list-actions">
          <button type="button" className="secondary-button" onClick={toggleAll} disabled={!jobs.length}>{allSelected ? "取消全选" : "全选"}</button>
          <button type="button" className="primary-button" onClick={downloadSelected} disabled={!selectedResults.length}>下载已选结果</button>
          <button type="button" className="icon-button" aria-label="刷新任务列表" onClick={() => void load("replace")}>↻</button>
        </div>
      </div>
      <div className="task-list-status" role="status" aria-live="polite">
        <span>已选 {selected.size} 项 · 可下载 {selectedResults.length} 张</span>
        {message && <span className={state === "error" ? "error-text" : ""}>{message}</span>}
      </div>
      {state === "loading" && !jobs.length ? (
        <div className="task-list-empty">正在读取任务…</div>
      ) : !jobs.length ? (
        <div className="task-list-empty">还没有任务。提交第一张图片后，状态会显示在这里。</div>
      ) : (
        <div className="task-table-wrap">
          <table className="task-table">
            <thead><tr><th scope="col"><span className="sr-only">选择</span></th><th scope="col">序号</th><th scope="col">参考图</th><th scope="col">提交时间</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">结果</th><th scope="col">输出图</th><th scope="col">操作</th></tr></thead>
            <tbody>
              {jobs.map((job, index) => {
                const id = job.id ?? `unknown-${index}`;
                const thumbnail = sourceUrl(job);
                return (
                  <tr key={id}>
                    <td><input type="checkbox" aria-label={`选择任务 ${job.id ?? index + 1}`} checked={Boolean(job.id && selected.has(job.id))} disabled={!job.id} onChange={() => job.id && toggleOne(job.id)} /></td>
                    <td><span className="task-sequence">{String(index + 1).padStart(2, "0")}</span></td>
                    <td>{thumbnail ? <button type="button" className="task-thumbnail-button" aria-label="查看任务参考图大图，双击或按回车键" onClick={(event) => { if (event.detail === 0 || (event.nativeEvent as PointerEvent).pointerType === "touch") openPreview(thumbnail, "任务参考图"); }} onDoubleClick={(event) => { event.preventDefault(); openPreview(thumbnail, "任务参考图"); }}><img className="task-thumbnail" src={thumbnail} alt="任务参考图缩略图" /></button> : <span>—</span>}</td>
                    <td><time dateTime={job.createdAt}>{formatTime(job.createdAt)}</time></td>
                    <td>{job.purpose === "preview" ? "参考图" : "成品图"}</td>
                    <td><span className={`task-status status-${job.status.toLowerCase()}`}>{job.reconciliationRequired ? privateTest === true && job.hasPendingOutputs ? "继续生成·待核对" : "待核对" : statusLabels[job.status] ?? job.status}</span>{(job.reconciliationRequired || job.message) && <small className="task-error">{job.reconciliationRequired ? privateTest === true && job.hasPendingOutputs ? "部分结果待核对；其余图片继续逐张执行。" : "本次结果与计费尚未确认，已停止自动重试；其他新任务可正常提交。" : job.message}</small>}</td>
                    <td>{job.results.length ? `${job.results.length}/${job.outputCount ?? job.results.length} 张` : `${job.completedOutputCount ?? 0}/${job.outputCount ?? 1} 张`}</td>
                    <td><div className="task-downloads">{job.results.map((result, resultIndex) => result.url ? <button key={result.assetId} type="button" className="task-thumbnail-button" aria-label={`查看任务输出图 ${resultIndex + 1} 大图，双击或按回车键`} onClick={(event) => { if (event.detail === 0 || (event.nativeEvent as PointerEvent).pointerType === "touch") openPreview(result.url!, `任务输出图 ${resultIndex + 1}`); }} onDoubleClick={(event) => { event.preventDefault(); openPreview(result.url!, `任务输出图 ${resultIndex + 1}`); }}><img className="task-thumbnail" src={result.url} alt={`任务输出图 ${resultIndex + 1} 缩略图`} /></button> : null)}{!job.results.some((result) => result.url) && <span>—</span>}</div></td>
                    <td><div className="task-downloads">{job.results.map((result, resultIndex) => result.url ? <a key={result.assetId} className="text-button" href={`${result.url}&download=1`} download>{job.results.length > 1 ? `下载 ${resultIndex + 1}` : "下载"}</a> : null)}{!historical && job.results.length > 0 && <button type="button" className="text-button" onClick={() => applyParameters(job)}>使用此图参数</button>}<details><summary>详情</summary><small>{job.model ?? job.providerPreference ?? "模型未记录"} · {job.resolution ?? "—"} · {job.aspectRatio ?? "—"} · 输入图片 {inputImageCount(job)} 张</small></details>{!job.results.length && <span className="muted">{job.reconciliationRequired ? "待人工核对" : "等待结果"}</span>}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor && <button type="button" className="task-load-more" onClick={() => void load("append")}>加载更早任务</button>}
      <dialog ref={previewDialog} className="task-preview-dialog" aria-labelledby="task-preview-title" onClose={() => { setPreview(null); setPreviewFailed(false); }}>
        <div className="task-preview-heading"><h2 id="task-preview-title">{preview?.label ?? "图片预览"}</h2><button type="button" aria-label="关闭图片预览" onClick={() => previewDialog.current?.close()}>关闭</button></div>
        <div className="task-preview-media">{previewFailed ? <p role="alert">图片加载失败，请关闭预览后重试。</p> : preview && <img src={preview.url} alt={preview.label} onError={() => setPreviewFailed(true)} />}</div>
      </dialog>
    </section>
  );
}
