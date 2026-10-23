"use client";

import { useState } from "react";
import { useAdminPage } from "../../../../components/admin/useAdminPage";
import { AdminPagination } from "../../../../components/admin/AdminPagination";

type ReconciliationCase = {
  id: string;
  jobId: string;
  itemId: string;
  reasonCode: string;
  provider: string | null;
  model: string | null;
  providerRequestId: string | null;
  state: "OPEN" | "CLOSED";
  openedAt: number;
};

export default function ReconciliationAdminPage() {
  const [state, setState] = useState<"OPEN" | "CLOSED">("OPEN");
  const page = useAdminPage(`/api/admin/generation/reconciliation?state=${state}&limit=25`);
  const items = (page.data?.items ?? []) as ReconciliationCase[];
  const status = page.data ? "ready" : page.busy ? "loading" : "error";
  const message = page.error;
  const chooseState = (next: "OPEN" | "CLOSED") => setState(next);
  const retry = page.refresh;
  return <main className="admin-page"><header className="admin-page-head"><div><h1>生成任务人工对账</h1><p>只读查看供应商结果不确定的任务。当前版本不提供重新生成或手工标记成功。</p></div></header><div className="inline-options" role="group" aria-label="对账状态"><button type="button" className={state === "OPEN" ? "active" : ""} onClick={() => chooseState("OPEN")}>待处理</button><button type="button" className={state === "CLOSED" ? "active" : ""} onClick={() => chooseState("CLOSED")}>已关闭</button></div>{status === "loading" && <div className="state-panel" role="status">正在读取对账任务…</div>}{status === "error" && <div className="state-panel error" role="alert"><p>{message}</p><button type="button" onClick={retry}>重试</button></div>}{status === "ready" && message && <p className="form-error" role="alert">{message}</p>}{status === "ready" && items.length === 0 && <div className="state-panel" role="status">当前没有{state === "OPEN" ? "待处理" : "已关闭"}对账任务。</div>}{status === "ready" && <><div className="task-table"><table><thead><tr><th>任务</th><th>原因</th><th>模型</th><th>供应商请求</th><th>进入时间</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td><strong>{item.jobId}</strong><small>{item.itemId}</small></td><td>{item.reasonCode}</td><td>{item.provider ?? "—"}<small>{item.model ?? "—"}</small></td><td>{item.providerRequestId ?? "未记录"}</td><td>{new Date(item.openedAt * 1000).toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div><AdminPagination pageNumber={page.pageNumber} count={items.length} hasNext={!!page.data?.nextCursor} busy={page.busy} previous={page.previous} next={page.next} /></>}</main>;
}
