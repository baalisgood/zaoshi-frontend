"use client";

import { useState } from "react";
import { useAdminPage } from "../../../../components/admin/useAdminPage";
import { AdminPagination } from "../../../../components/admin/AdminPagination";

type DeadLetter = {
  id: string;
  jobId: string;
  itemId: string;
  attemptId: string;
  reasonCode: string;
  retryClass: string;
  attemptNo: number;
  attemptCount: number;
  maxAttempts: number;
  state: "OPEN" | "RESOLVED";
  openedAt: number;
};

export default function DeadLetterAdminPage() {
  const [state, setState] = useState<"OPEN" | "RESOLVED">("OPEN");
  const page = useAdminPage(`/api/admin/generation/dead-letters?state=${state}&limit=25`);
  const items = (page.data?.items ?? []) as DeadLetter[];
  const status = page.data ? "ready" : page.busy ? "loading" : "error";
  const message = page.error;
  const chooseState = (next: "OPEN" | "RESOLVED") => setState(next);
  const retry = page.refresh;
  return <section className="admin-page"><header className="admin-page-head"><div><span className="zs-admin-kicker">异常处理</span><h1>生成任务死信</h1><p>只读查看供应商调用前最终失败的任务。供应商结果不确定的任务仍在人工对账页处理，本页不提供重试或手工成功。</p></div></header><div className="inline-options zs-admin-segment" role="group" aria-label="死信状态"><button type="button" className={state === "OPEN" ? "active" : ""} onClick={() => chooseState("OPEN")}>待处理</button><button type="button" className={state === "RESOLVED" ? "active" : ""} onClick={() => chooseState("RESOLVED")}>已安全重排</button></div>{status === "loading" && <div className="state-panel" role="status">正在读取死信任务…</div>}{status === "error" && <div className="state-panel error" role="alert"><p>{message}</p><button type="button" onClick={retry}>重试</button></div>}{status === "ready" && message && <p className="form-error" role="alert">{message}</p>}{status === "ready" && items.length === 0 && <div className="state-panel" role="status">当前没有{state === "OPEN" ? "待处理" : "已安全重排"}死信任务。</div>}{status === "ready" && <><div className="task-table admin-table"><table><thead><tr><th>任务</th><th>失败原因</th><th>尝试</th><th>进入时间</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.jobId}</strong><small>{item.itemId}</small></td><td>{item.reasonCode}<small>{item.retryClass}</small></td><td>{item.attemptNo} / {item.attemptCount} / {item.maxAttempts}</td><td>{new Date(item.openedAt * 1000).toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div><AdminPagination pageNumber={page.pageNumber} count={items.length} hasNext={!!page.data?.nextCursor} busy={page.busy} previous={page.previous} next={page.next} /></>}</section>;
}
