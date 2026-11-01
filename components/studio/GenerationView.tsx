"use client";

/* eslint-disable @next/next/no-img-element -- Generated asset URLs are supplied by the API. */

import { GenerationController } from "@/components/studio/useGenerationJob";
import { useFinalizeGenerationPricing } from "@/components/studio/useGenerationPricing";
import { usePrivateTestMode } from "@/components/studio/StudioFields";

const labels: Record<string, { title: string; note: string; step: number }> = {
  SUBMITTING: { title: "正在提交", note: "正在创建真实生成任务", step: 0 },
  QUEUED: { title: "任务已排队", note: "正在等待处理资源", step: 0 },
  PREPROCESSING: { title: "分析空间", note: "正在准备输入与控制信息", step: 1 },
  GENERATING: { title: "生成方案", note: "图像服务正在处理", step: 2 },
  VALIDATING: { title: "检查结果", note: "正在验证输出图片", step: 3 },
  POLLING_FAILED: { title: "状态查询中断", note: "任务编号仍保留，可重新查询", step: 0 },
  FAILED: { title: "本次未完成", note: "请根据错误信息调整后重试", step: 0 },
  CANCELED: { title: "任务已取消", note: "没有返回可展示结果", step: 0 },
};

export function GenerationView({ controller, onLocalEdit, resolution = "2K", quality = "standard", optionId, providerPreference }: { controller: GenerationController; onLocalEdit?: (assetId: string, url?: string) => void; resolution?: string; quality?: string; optionId?: string; providerPreference?: string }) {
  const privateTest = usePrivateTestMode();
  const { job, busy, pollingLost, retry } = controller;
  const finalizePricing = useFinalizeGenerationPricing(privateTest === false && job?.purpose === "preview" && job.provider !== "mock" ? job.id : undefined, resolution, 1, quality, optionId, providerPreference);
  if (!job) return <section className="result-empty"><span aria-hidden="true">⌑</span><strong>结果将在这里出现</strong><p>提交后可继续创建新任务；进度和完成结果会保留在下方任务列表中。</p></section>;

  const done = job.status === "SUCCEEDED" || job.status === "PARTIAL_SUCCEEDED";
  const state = job.reconciliationRequired ? { title: privateTest === true && job.hasPendingOutputs ? "继续生成·待核对" : "待核对", note: privateTest === true && job.hasPendingOutputs ? "部分结果待核对；其余图片继续逐张执行。" : "本次结果与计费尚未确认，已停止自动重试；其他新任务可正常提交。", step: 3 } : labels[job.status];
  if (!done) {
    return (
      <section className={`job-state ${job.status === "FAILED" || pollingLost ? "error" : ""}`} aria-live="polite" aria-busy={busy}>
        <div className="job-state-head"><span aria-hidden="true">{busy ? "◌" : "!"}</span><div><strong>{state?.title ?? job.status}</strong><p>{job.reconciliationRequired ? state?.note : job.message ?? state?.note ?? "任务状态正在更新"}</p></div></div>
        {busy && <ol className="job-steps">{["已提交", "分析空间", "生成方案", "检查结果"].map((label, index) => <li key={label} className={(state?.step ?? 0) >= index ? "active" : ""}>{label}</li>)}</ol>}
        {job.results.length > 0 && <div className="generated-grid">{job.results.map((result, index) => <article className="generated-card" key={result.assetId}><div className="generated-image">{result.url && <img src={result.url} alt={`已完成图片 ${index + 1}`} />}</div><div className="generated-actions"><strong>已完成 {index + 1}/{job.outputCount ?? job.results.length} 张</strong>{result.url && <a href={`${result.url}&download=1`} download>下载</a>}</div></article>)}</div>}
        {pollingLost && job.id && <button className="secondary-button" type="button" onClick={() => void retry()}>重新查询任务状态</button>}
      </section>
    );
  }

  const mock = job.provider === "mock";
  const bareShell = job.taskMode === "bare-shell";
  return (
    <section aria-live="polite">
      {controller.finalizeError && job.purpose === "preview" && <p role="alert" className="summary-note error-text">{controller.finalizeError} 参考图仍可再次尝试。</p>}
      {finalizePricing.error && job.purpose === "preview" && !privateTest && <p role="alert" className="summary-note error-text">{finalizePricing.error}</p>}
      {privateTest && job.purpose === "preview" && <p className="summary-note" role="note">私测暂不支持参考图直接晋升成品图；可在工作台重新提交单张成品任务。</p>}
      <div className={`result-notice ${job.status === "PARTIAL_SUCCEEDED" ? "partial" : ""} ${mock ? "mock" : ""}`}>
        <span aria-hidden="true">{job.status === "PARTIAL_SUCCEEDED" ? "!" : "✓"}</span>
        <div><strong>{mock ? "Mock接口测试结果" : job.status === "PARTIAL_SUCCEEDED" ? "部分结果已返回" : bareShell ? "毛坯结构图已返回" : "概念效果图已返回"}</strong><p>{mock ? "以下图片只是原图占位，没有调用图像模型，也不代表生成质量。" : bareShell ? `${job.results.length} 张毛坯结构图已通过文件检查；请对照原图确认墙体、门窗和梁柱没有跑偏；结果可在下方任务列表下载。` : `${job.results.length} 张结果已通过文件检查；空间结构与设计合理性仍需人工复核。`}</p></div>
      </div>
      <div className="generated-grid">
        {job.results.map((result, index) => {
          const reusable = mock || result.moderationStatus !== "REJECTED";
          return <article className="generated-card" key={result.assetId}>
            <div className="generated-image">{result.url ? <img src={result.url} alt={`${bareShell ? "毛坯结构图" : "概念效果图"} ${index + 1}`} /> : <span>结果地址暂不可用</span>}{mock && <b>MOCK · 原图占位</b>}</div>
            <div className="generated-actions"><div><strong>{bareShell ? "毛坯结构图" : "方案"} {String(index + 1).padStart(2, "0")}</strong><small>{job.model ?? job.provider ?? "图像服务"}</small></div>{bareShell ? <small>请在下方任务列表下载。</small> : reusable ? <span className="action-row"><a href={`/pro?asset=${encodeURIComponent(result.assetId)}`}>高级精修</a>{job.purpose === "preview" && !mock && privateTest === false && <button type="button" disabled={controller.busy || !finalizePricing.quote} onClick={() => { const quote = finalizePricing.quote; if (!quote) return; void controller.finalize({ optionId, providerPreference, selectedOutputAssetId: result.assetId, resolution, quality, outputCount: 1, expectedPriceVersion: quote.priceVersion, expectedTotalCredits: quote.totalCredits, idempotencyKey: `finalize:${job.id}:${result.assetId}:${optionId}:${resolution}:${quality}` }); }}>生成高清成品 · {finalizePricing.quote ? `${finalizePricing.quote.totalCredits}积分` : "报价中"}</button>}{onLocalEdit && !mock && <button type="button" onClick={() => onLocalEdit(result.assetId, result.url)}>局部修改</button>}</span> : <small>图片不可继续使用。</small>}</div>
          </article>;
        })}
      </div>
    </section>
  );
}
