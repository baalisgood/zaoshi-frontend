"use client";

/* eslint-disable @next/next/no-img-element -- Asset thumbnails come from the project API. */

import { useEffect, useMemo, useState } from "react";
import { AssetRecord, deleteAsset, listAssets } from "@/components/site/api";

type LibraryState = "loading" | "ready" | "error";
type Filter = "all" | "source" | "output" | "floorplan" | "controls";
const filters: { value: Filter; label: string }[] = [{ value: "all", label: "全部" }, { value: "source", label: "现场原图" }, { value: "output", label: "生成结果" }, { value: "floorplan", label: "平面图" }, { value: "controls", label: "控制图" }];
const kindLabels: Record<string, string> = { source: "现场原图", reference: "风格参考", output: "生成结果", floorplan: "平面图", depth: "深度图", normal: "法线图", mask: "局部蒙版" };

export function AssetLibrary() {
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [state, setState] = useState<LibraryState>("loading");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [deleting, setDeleting] = useState<string>();
  async function load() { setState("loading"); setMessage(""); try { setAssets(await listAssets("all", 100)); setState("ready"); } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "方案库暂时无法读取。"); } }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial remote state belongs in this client-only library view.
  useEffect(() => { void load(); }, []);
  const visible = useMemo(() => assets.filter((asset) => filter === "all" || (filter === "controls" ? asset.kind === "depth" || asset.kind === "normal" : asset.kind === filter)), [assets, filter]);

  return <div className="page-shell library-page">
    <header className="page-intro"><div><span className="section-kicker">ASSET LIBRARY</span><h1>方案库</h1><p>这里保存当前账户的生成结果；输入素材会按任务恢复与清理策略自动删除。</p></div><span className="page-tag">最多显示100项</span></header>
    <div className="library-toolbar"><div className="filter-tabs" role="group" aria-label="筛选方案库图片">{filters.map((item) => <button type="button" key={item.value} className={filter === item.value ? "selected" : ""} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>{state === "ready" && <span>{visible.length} / {assets.length} 项</span>}</div>
    {message && <p className="inline-notice" role={state === "error" ? "alert" : "status"}>{message}</p>}
    {state === "loading" && <div className="state-panel library-state" role="status">正在读取方案库…</div>}
    {state === "error" && <div className="state-panel library-state error"><button type="button" onClick={() => void load()}>重试</button></div>}
    {state === "ready" && !visible.length && <div className="state-panel library-state"><strong>当前分类还没有图片</strong><p>完成生成后，结果会出现在这里。</p></div>}
    {state === "ready" && visible.length > 0 && <div className="library-grid">{visible.map((asset) => {
      const usable = asset.moderationStatus !== "REJECTED";
      async function remove() { if (deleting || !window.confirm("删除后图片会立即停止显示且无法恢复，确认删除吗？")) return; setDeleting(asset.id); try { await deleteAsset(asset.id); setAssets((current) => current.filter((item) => item.id !== asset.id)); } catch (error) { setMessage(error instanceof Error ? error.message : "图片删除失败。"); } finally { setDeleting(undefined); } }
      return <article className="library-card" key={asset.id}><div className="library-media"><img src={asset.url} alt={asset.fileName ?? kindLabels[asset.kind] ?? "方案素材"} /><span>{kindLabels[asset.kind] ?? asset.kind}</span></div><div className="library-card-copy"><strong>{asset.fileName ?? kindLabels[asset.kind] ?? "未命名图片"}</strong><p>{asset.width && asset.height ? `${asset.width} × ${asset.height}px` : "尺寸读取中或未记录"}</p>{asset.createdAt && <time dateTime={asset.createdAt}>{new Date(asset.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>}</div><div className="library-actions">{usable && (asset.kind === "source" || asset.kind === "output") && <a href={`/pro?asset=${encodeURIComponent(asset.id)}`}>{asset.kind === "output" ? "作为基底精修" : "高级精修"}</a>}{usable && asset.kind === "output" && <a href={`/pro?reference=${encodeURIComponent(asset.id)}`}>作为概念参考</a>}{usable && asset.kind === "source" && <a href={`/studio?asset=${encodeURIComponent(asset.id)}`}>生成新方向</a>}{usable && asset.kind === "floorplan" && <a href={`/api/assets/${encodeURIComponent(asset.id)}?content=1&download=1`} download>下载原图</a>}<button type="button" disabled={Boolean(deleting)} onClick={() => void remove()}>{deleting === asset.id ? "正在删除…" : "删除图片"}</button></div></article>;
    })}</div>}
  </div>;
}
