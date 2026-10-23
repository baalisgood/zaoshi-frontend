"use client";

import { UserIdentifier } from "./UserIdentifier";
import { useAdminPage } from "./useAdminPage";

type Row = { id: string; order_id: string; owner_id: string; status: string; amount_fen: number; paid_at: number; reason: string };

export function RechargeReconciliationView() {
  const page = useAdminPage("/api/admin/recharge");
  const rows = page.data?.records as Row[] | undefined;
  return <section className="admin-page"><header className="admin-page-head"><div><h1>充值待对账</h1><p>验签确认实收、未自动入账的记录。仅显示最近 100 条待对账记录；现金退款由客服核实后原路办理。</p></div><button type="button" className="secondary-button" disabled={page.busy} onClick={page.refresh}>刷新</button></header>
    {page.error && <div className="admin-notice error" role="alert"><p>{page.error}</p><button type="button" disabled={page.busy} onClick={page.refresh}>重试</button></div>}
    {!rows && page.busy && <div className="state-panel" role="status">正在读取充值记录…</div>}
    {rows && (rows.length ? <><div className="admin-table"><table><thead><tr>{["订单", "账户", "实收", "支付时间", "原订单状态", "原因"].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{row.order_id}</td><td><UserIdentifier id={row.owner_id} /></td><td className="admin-numeric">¥{(row.amount_fen / 100).toFixed(2)}</td><td>{new Date(row.paid_at * 1000).toLocaleString("zh-CN")}</td><td>{row.status}</td><td>{row.reason === "OUTSIDE_PAYMENT_WINDOW" ? "支付发生在订单有效期外" : "原订单不可自动入账"}</td></tr>)}</tbody></table></div><p className="admin-range-note">当前显示 {rows.length} 条 · 只读记录</p></> : <div className="state-panel">暂无待对账充值。</div>)}
  </section>;
}
