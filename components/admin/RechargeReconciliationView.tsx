"use client";

import { useState } from "react";
import { AdminIcon } from "./AdminIcons";
import { OrderStatusChip, ToneChip, formatNumber } from "./AdminLabels";
import { AdminPagination } from "./AdminPagination";
import { UserIdentifier } from "./UserIdentifier";
import { useAdminPage } from "./useAdminPage";

type Row = { id: string; order_id: string; owner_id: string; status: string; amount_fen: number; paid_at: number; verified_at?: number; reason: string; product_code?: string; credits?: number; provider_transaction_id?: string };
type Summary = { total: number; amountFen: number; owners: number };

const reasonText = (reason: string) => reason === "OUTSIDE_PAYMENT_WINDOW" ? "支付发生在订单有效期外" : "原订单不可自动入账";
const yuan = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const time = (seconds?: number) => seconds ? new Date(seconds * 1000).toLocaleString("zh-CN") : "—";

export function RechargeReconciliationView() {
  const [reason, setReason] = useState("ALL");
  const [ownerId, setOwnerId] = useState(""); const [ownerDraft, setOwnerDraft] = useState("");
  const [orderId, setOrderId] = useState(""); const [orderDraft, setOrderDraft] = useState("");
  const params = new URLSearchParams({ limit: "25", reason });
  if (ownerId) params.set("ownerId", ownerId);
  if (orderId) params.set("orderId", orderId);
  const page = useAdminPage(`/api/admin/recharge?${params}`);
  const rows = page.data?.records as Row[] | undefined;
  const summary = page.data?.summary as Summary | undefined;
  const filtered = reason !== "ALL" || !!ownerId || !!orderId;
  return <section className="admin-page"><header className="admin-page-head"><div><span className="zs-admin-kicker">用户与积分</span><h1>充值待对账</h1><p>验签确认实收、未自动入账的记录，只读展示。现金退款由客服核实后原路办理，请勿让用户重复付款。</p></div><button type="button" className="secondary-button zs-admin-refresh" disabled={page.busy} onClick={page.refresh}><AdminIcon name="refresh" size={16} />刷新</button></header>
    <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); setOwnerId(ownerDraft.trim()); setOrderId(orderDraft.trim()); }}>
      <label>原因<select value={reason} onChange={(event) => setReason(event.target.value)}><option value="ALL">全部原因</option><option value="OUTSIDE_PAYMENT_WINDOW">支付发生在订单有效期外</option><option value="ORDER_NOT_PAYABLE">原订单不可自动入账</option></select></label>
      <label>账户<input value={ownerDraft} onChange={(event) => setOwnerDraft(event.target.value)} placeholder="完整用户 ID" /></label>
      <label>订单<input value={orderDraft} onChange={(event) => setOrderDraft(event.target.value)} placeholder="完整订单号" /></label>
      <button type="submit">查询</button>
      {filtered && <button type="button" className="zs-admin-text-button" onClick={() => { setReason("ALL"); setOwnerId(""); setOwnerDraft(""); setOrderId(""); setOrderDraft(""); }}>清除筛选</button>}
    </form>
    {summary && <div className="admin-metrics"><article><span>{filtered ? "符合条件记录" : "对账记录"}</span><strong>{formatNumber(summary.total)}</strong></article><article><span>涉及实收</span><strong>{yuan(summary.amountFen)}</strong></article><article><span>涉及账户</span><strong>{formatNumber(summary.owners)}</strong></article></div>}
    {page.error && <div className="admin-notice error" role="alert"><p>{page.error}</p><button type="button" disabled={page.busy} onClick={page.refresh}>重试</button></div>}
    {!rows && page.busy && <div className="state-panel zs-admin-loading" role="status"><span className="zs-admin-spinner" aria-hidden="true" />正在读取充值记录…</div>}
    {rows && (rows.length ? <><div className="admin-table"><table><thead><tr>{["订单", "账户", "实收", "套餐", "支付时间", "原订单状态", "原因"].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><code className="zs-admin-code">{row.order_id}</code>{row.provider_transaction_id && <small className="zs-admin-sub">微信单号 {row.provider_transaction_id}</small>}</td><td><UserIdentifier id={row.owner_id} /></td><td className="admin-numeric"><strong>{yuan(row.amount_fen)}</strong></td><td>{row.product_code ?? "—"}{row.credits ? <small className="zs-admin-sub">{formatNumber(row.credits)} 积分</small> : null}</td><td>{time(row.paid_at)}{row.verified_at ? <small className="zs-admin-sub">验签 {time(row.verified_at)}</small> : null}</td><td><OrderStatusChip value={row.status} /></td><td><ToneChip tone="warning">{reasonText(row.reason)}</ToneChip></td></tr>)}</tbody></table></div><AdminPagination pageNumber={page.pageNumber} count={rows.length} hasNext={!!page.data?.nextCursor} busy={page.busy} previous={page.previous} next={page.next} /></> : <div className="state-panel zs-admin-empty"><span aria-hidden="true"><AdminIcon name="check" size={22} /></span><p>{filtered ? "没有符合条件的充值对账记录。" : "暂无充值待对账记录。"}</p></div>)}
  </section>;
}
