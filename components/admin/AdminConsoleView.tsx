"use client";

import { UserIdentifier } from "./UserIdentifier";
import { useAdminPage } from "./useAdminPage";
import { AdminPagination } from "./AdminPagination";
import { type ReactNode, FormEvent, useEffect, useRef, useState } from "react";

type View = "overview" | "users" | "credits" | "tasks" | "providers" | "analytics" | "audit";
type Data = Record<string, unknown>;
type User = { id: string; displayName: string; status: "ACTIVE" | "SUSPENDED"; role: string; createdAt: number; activeSessions: number; jobCount: number; availableCredits: number; limits: { dailyOutputLimit: number; maxPendingOutputs: number; activeConcurrencyLimit: number; enabled: boolean } };
type Credit = { id: string; ownerId: string; entryType: string; amount: number; reasonCode: string; optimizationId?: string | null; priceVersion?: string | null; jobId?: string | null; createdAt: number };
type Task = { id: string; jobId: string; ownerId: string; status: string; providerKey: string; providerPreference: string; model?: string | null; attemptCount: number; maxAttempts: number; errorCode?: string | null; billingState: string; updatedAt: number };
type Provider = { model: string; label: string; provider: string; configured: boolean; attempts: number; succeeded: number; failed: number; lastAttemptAt?: number | null };
type AuditEvent = { id: string; source: string; action: string; actorId: string; targetType: string; targetId: string; detail: Record<string, unknown>; createdAt: number };
type QueueMonitor = { enabled: boolean; consumer: { status: string; state: string | null; updatedAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null }; metrics: { dueCandidates: number; oldestCandidateAgeSeconds: number | null; dueRetries: number; expiredLeases: number; successesLastHour: number; failuresLastHour: number; averageCompletionSeconds: number | null; openReconciliation: number; unprocessedDeadLetters: number; blockedObjectCleanup: number }; alerts: string[] };

const labels: Record<View, [string, string]> = {
  overview: ["运营总览", "真实数据来自当前数据库；未接入的数据会明确标注。"],
  users: ["用户管理", "查看账户状态、会话、生成额度和积分，并执行受审计的停用或额度调整。"],
  credits: ["积分账本", "账本只追加不可改写；仅支持受审计的正向赠送与补偿。"],
  tasks: ["任务监控", "查看持久队列、尝试次数、错误码和积分预留状态。"],
  providers: ["供应商状态", "只显示服务端配置与历史调用结果，不主动探测、不暴露密钥。"],
  analytics: ["运营分析", "按北京时间查看访问量、访客数和有效停留时长。"],
  audit: ["完整审计记录", "汇总管理员、队列、对账、图片与灵感库的不可变操作记录。"],
};

export function AdminConsoleView({ view }: { view: View }) {
  const [period, setPeriod] = useState("day");
  const [status, setStatus] = useState("ALL");
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [ownerDraft, setOwnerDraft] = useState("");
  const [auditSource, setAuditSource] = useState("ALL");
  const [auditActor, setAuditActor] = useState("");
  const [auditActorDraft, setAuditActorDraft] = useState("");
  const [auditTarget, setAuditTarget] = useState("");
  const [auditTargetDraft, setAuditTargetDraft] = useState("");
  const params = new URLSearchParams({ view, limit: "25" });
  if (view === "analytics") params.set("period", period);
  if (view === "users" || view === "tasks") params.set("status", status);
  if (view === "users" && query) params.set("q", query);
  if (view === "credits" && ownerId) params.set("ownerId", ownerId);
  if (view === "audit") { params.set("source", auditSource); if (auditActor) params.set("actorId", auditActor); if (auditTarget) params.set("targetId", auditTarget); }
  const page = useAdminPage(`/api/admin/console?${params}`);
  const { data, refresh, error: message } = page;
  const state = data ? "ready" : page.busy ? "loading" : "error";
  useEffect(() => {
    if (view !== "overview" && view !== "tasks") return;
    const refreshVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = window.setInterval(refreshVisible, 30_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible); };
  }, [view, refresh]);

  return <section className="admin-page"><header className="admin-page-head"><div><h1>{labels[view][0]}</h1><p>{labels[view][1]}</p></div><button type="button" className="secondary-button" disabled={page.busy} onClick={refresh}>刷新本页</button></header>
    {view === "analytics" && <div className="admin-filters"><label>统计周期<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="day">今日</option><option value="week">本周</option><option value="month">本月</option></select></label></div>}
    {view === "users" && <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); setQuery(queryDraft.trim()); }}><label>搜索<input value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} placeholder="用户 ID 或昵称" /></label><label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="ALL">全部</option><option value="ACTIVE">正常</option><option value="SUSPENDED">已停用</option></select></label><button type="submit">查询</button></form>}
    {view === "tasks" && <div className="admin-filters"><label>任务状态<select value={status} onChange={(event) => setStatus(event.target.value)}>{["ALL","QUEUED","LEASED","PREPROCESSING","SUBMITTING","PERSISTING","RETRY_WAIT","SUCCEEDED","FAILED","RECONCILIATION_REQUIRED","CANCELED"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>}
    {view === "credits" && <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); setOwnerId(ownerDraft.trim()); }}><label>账户筛选<input value={ownerDraft} onChange={(event) => setOwnerDraft(event.target.value)} placeholder="粘贴完整用户 ID" /></label><button type="submit">查询</button></form>}
    {view === "audit" && <form className="admin-filters" onSubmit={(event) => { event.preventDefault(); setAuditActor(auditActorDraft.trim()); setAuditTarget(auditTargetDraft.trim()); }}><label>来源<select value={auditSource} onChange={(event) => setAuditSource(event.target.value)}><option value="ALL">全部</option><option value="ADMIN">管理员</option><option value="QUEUE">任务重排</option><option value="RECONCILIATION">任务对账</option><option value="ASSET_MAINTENANCE">文件维护</option><option value="ASSET_MODERATION">图片审核</option><option value="ASSET_DELETION">图片删除</option><option value="GALLERY">灵感库</option></select></label><label>操作人<input value={auditActorDraft} onChange={(event) => setAuditActorDraft(event.target.value)} placeholder="精确 ID" /></label><label>目标<input value={auditTargetDraft} onChange={(event) => setAuditTargetDraft(event.target.value)} placeholder="精确 ID" /></label><button type="submit">查询</button></form>}
    {state === "loading" && <div className="state-panel" role="status">正在读取管理数据…</div>}
    {state === "error" && <div className="state-panel error" role="alert"><p>{message}</p><button type="button" onClick={refresh}>重试</button></div>}
    {state === "ready" && message && <p className="form-error" role="alert">{message}</p>}
    {state === "ready" && data && <><AdminContent view={view} data={data} refresh={refresh} />{["users", "credits", "tasks", "audit"].includes(view) && <AdminPagination pageNumber={page.pageNumber} count={(data.items as unknown[] ?? []).length} hasNext={!!data.nextCursor} busy={page.busy} previous={page.previous} next={page.next} />}</>}
  </section>;
}

function AdminContent({ view, data, refresh }: { view: View; data: Data; refresh: () => void }) {
  if (view === "overview") return <Overview data={data} />;
  if (view === "users") return <Users data={data} refresh={refresh} />;
  if (view === "credits") return <Credits data={data} refresh={refresh} />;
  if (view === "tasks") return <Tasks data={data} />;
  if (view === "providers") return <Providers data={data} />;
  if (view === "audit") return <Audit data={data} />;
  return <Analytics data={data} />;
}

function Overview({ data }: { data: Data }) {
  const users = data.users as Record<string, number>; const tasks = data.tasks as Record<string, number>; const issues = data.issues as Record<string, number>; const credits = data.credits as Record<string, number>; const analytics = data.analytics as Record<string, number>;
  return <><MetricGrid items={[["用户总数", users.total],["正常用户", users.active],["待处理任务", tasks.pending],["今日 PV", analytics.pv],["今日 UV", analytics.uv],["可用积分", credits.available],["冻结积分", credits.reserved],["待对账 / 死信", `${issues.reconciliation} / ${issues.dead_letters}`]]} /><QueueMonitorPanel queue={data.queue as QueueMonitor} /><div className="admin-notice"><strong>充值统计基于已验证到账订单</strong><p>已确认到账的支付充值统计见运营分析；人工赠送积分不计作支付充值。待处理实收记录可在充值待对账页查看。</p></div><div className="admin-quick-links"><a href="/admin/users">管理用户</a><a href="/admin/credits">查看积分</a><a href="/admin/tasks">监控任务</a><a href="/admin/analytics">运营分析</a></div></>;
}

function Users({ data, refresh }: { data: Data; refresh: () => void }) {
  const items = (data.items ?? []) as User[];
  const [editing, setEditing] = useState<User | null>(null);
  return <>{items.length ? <Table headers={["账户", "用户 ID", "状态 / 角色", "积分", "任务", "会话", "生成权限", "操作"]} rows={items.map(user => [<strong key="name" className="admin-user-name" title={user.displayName}>{user.displayName}</strong>, <UserIdentifier key={user.id} id={user.id} />, <span key="status" className="admin-user-state"><span className={`status-pill ${user.status === "SUSPENDED" ? "error" : "admin-status-active"}`}>{user.status === "ACTIVE" ? "正常" : "停用"}</span> <small>{user.role}</small></span>, user.availableCredits, user.jobCount, user.activeSessions, <span key="limits" title={`每日 ${user.limits.dailyOutputLimit} 张 · 待处理 ${user.limits.maxPendingOutputs} · 并发 ${user.limits.activeConcurrencyLimit}`}>{user.limits.enabled ? "允许" : "关闭"} · {user.limits.dailyOutputLimit}/日</span>, <button key="edit" type="button" onClick={() => setEditing(user)} aria-label={`编辑用户 ${user.displayName}`}>编辑</button>])} /> : <div className="state-panel">没有符合条件的用户。</div>}{editing && <UserEditor user={editing} close={() => setEditing(null)} refresh={refresh} />}</>;
}

function UserEditor({ user, refresh, close }: { user: User; refresh: () => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { const element = dialog.current; const trigger = document.activeElement as HTMLElement | null; element?.showModal(); return () => { element?.close(); trigger?.focus(); }; }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setMessage(""); const form = new FormData(event.currentTarget);
    try { await adminMutation("PATCH", { action: "UPDATE_USER", actionId: `admin_${crypto.randomUUID()}`, userId: user.id, status: form.get("status"), dailyOutputLimit: Number(form.get("daily")), maxPendingOutputs: Number(form.get("pending")), activeConcurrencyLimit: Number(form.get("concurrency")), enabled: form.get("enabled") === "on" }); refresh(); close(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); } finally { submitting.current = false; setBusy(false); }
  };
  return <dialog ref={dialog} className="admin-edit-dialog" aria-labelledby="admin-edit-title" onCancel={event => { event.preventDefault(); if (!submitting.current) close(); }}><form onSubmit={submit}><header><div><h2 id="admin-edit-title">编辑用户</h2><p>{user.displayName} · {user.id}</p></div><button type="button" disabled={busy} onClick={close} aria-label="关闭编辑">×</button></header><p className="admin-dialog-note">角色 {user.role} · 停用会撤销该账户会话；所有修改记录审计。</p><fieldset disabled={busy}><label>账户状态<select name="status" defaultValue={user.status}><option value="ACTIVE">正常</option><option value="SUSPENDED">停用并撤销会话</option></select></label><label>每日张数<input required name="daily" type="number" min="1" max="1000" defaultValue={user.limits.dailyOutputLimit} /></label><label>待处理上限<input required name="pending" type="number" min="1" max="100" defaultValue={user.limits.maxPendingOutputs} /></label><label>并发<input required name="concurrency" type="number" min="1" max="16" defaultValue={user.limits.activeConcurrencyLimit} /></label><label className="admin-check"><input name="enabled" type="checkbox" defaultChecked={user.limits.enabled} />允许生成</label></fieldset>{message && <p className="form-error" role="alert">{message}</p>}<footer><button type="button" disabled={busy} onClick={close}>取消</button><button disabled={busy} type="submit">{busy ? "保存中…" : "保存修改"}</button></footer></form></dialog>;
}

function Credits({ data, refresh }: { data: Data; refresh: () => void }) {
  const summary = data.summary as Record<string, number>; const items = (data.items ?? []) as Credit[];
  const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false); const submitting = useRef(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setMessage(""); const formElement = event.currentTarget; const form = new FormData(formElement); try { await adminMutation("POST", { action: form.get("action"), actionId: `admin_${crypto.randomUUID()}`, userId: form.get("userId"), amount: Number(form.get("amount")) }); setMessage("积分已写入不可变账本。"); formElement.reset(); refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : "积分写入失败"); } finally { submitting.current = false; setBusy(false); } };
  return <><MetricGrid items={[["累计入账", summary.credited],["当前可用", summary.available],["任务冻结", summary.reserved],["累计消耗", summary.spent]]} /><details className="admin-action-disclosure"><summary>人工发放积分</summary><form className="admin-credit-form" onSubmit={submit}><div><strong>人工发放积分</strong><p>只允许正向赠送或补偿，不能修改、删除或伪造任务结算。</p></div><label>完整用户 ID<input required name="userId" /></label><label>类型<select name="action"><option value="CREDIT_GRANT">运营赠送</option><option value="CREDIT_COMPENSATION">故障补偿</option></select></label><label>积分<input required name="amount" type="number" min="1" max="1000000" /></label><button disabled={busy} type="submit">{busy ? "写入中…" : "确认写入"}</button>{message && <small role="status">{message}</small>}</form></details>{items.length ? <Table headers={["账户","类型","数量","原因","任务/版本","时间"]} rows={items.map((item) => [<UserIdentifier key={item.ownerId} id={item.ownerId} />,item.entryType,String(item.amount),(item.reasonCode === "PROMPT_OPTIMIZATION" ? "AI 提示词优化" : item.reasonCode),item.optimizationId ?? item.jobId ?? item.priceVersion ?? "—",formatTime(item.createdAt)])} /> : <div className="state-panel">当前没有积分流水。</div>}</>;
}

function Tasks({ data }: { data: Data }) {
  const summary = data.summary as Record<string, number>; const items = (data.items ?? []) as Task[];
  return <><TaskQueueSummary queue={data.queue as QueueMonitor} /><details className="admin-action-disclosure"><summary>队列运行详情</summary><QueueMonitorPanel queue={data.queue as QueueMonitor} /></details><div className="admin-status-strip">{Object.entries(summary).map(([key, value]) => <span key={key}><b>{key}</b>{value}</span>)}</div>{items.length ? <Table headers={["任务","用户","状态","模型","尝试","积分","错误","更新时间"]} rows={items.map((item) => [item.jobId,<UserIdentifier key={item.ownerId} id={item.ownerId} />,item.status,item.model ?? item.providerPreference,`${item.attemptCount}/${item.maxAttempts}`,item.billingState,item.errorCode ?? "—",formatTime(item.updatedAt)])} /> : <div className="state-panel">当前没有任务。</div>}</>;
}

function TaskQueueSummary({ queue }: { queue: QueueMonitor }) {
  return <div className="admin-notice"><strong>Consumer：{consumerStatus(queue.consumer.status)}</strong><span className="admin-queue-brief">候选 {queue.metrics.dueCandidates} · 到期重试 {queue.metrics.dueRetries} · 待对账 {queue.metrics.openReconciliation} · 未处理死信 {queue.metrics.unprocessedDeadLetters}</span>{!queue.enabled && <p>内部队列当前主动关闭，不视为故障。</p>}{queue.alerts.length > 0 && <p className="form-error" role="alert">{queue.alerts.map(queueAlertLabel).join("；")}</p>}</div>;
}

function QueueMonitorPanel({ queue }: { queue: QueueMonitor }) {
  const metrics = queue.metrics;
  return <section className="admin-queue-monitor" aria-label="生产队列监控"><div className="admin-notice"><strong>Consumer：{consumerStatus(queue.consumer.status)}</strong><p>{queue.enabled ? `健康快照：${queue.consumer.updatedAt ? formatIsoTime(queue.consumer.updatedAt) : "暂无"}${queue.consumer.lastErrorCode ? ` · ${queue.consumer.lastErrorCode}` : ""}` : "内部队列当前主动关闭，不视为故障。"}</p></div><MetricGrid items={[["已到调度时间（不代表最终可领取）", metrics.dueCandidates],["最老候选等待", metrics.oldestCandidateAgeSeconds == null ? "—" : duration(metrics.oldestCandidateAgeSeconds)],["到期重试候选", metrics.dueRetries],["过期租约", metrics.expiredLeases],["近 1 小时成功 / 失败", `${metrics.successesLastHour} / ${metrics.failuresLastHour}`],["平均完成耗时", metrics.averageCompletionSeconds == null ? "—" : duration(metrics.averageCompletionSeconds)],["待对账", metrics.openReconciliation],["未处理死信", metrics.unprocessedDeadLetters],["文件清理阻塞", metrics.blockedObjectCleanup]]} />{queue.alerts.length > 0 && <div className="admin-notice error" role="alert"><strong>队列需要处理</strong><p>{queue.alerts.map(queueAlertLabel).join("；")}</p></div>}</section>;
}

function Providers({ data }: { data: Data }) {
  const items = data.models as Provider[];
  return <><div className="admin-notice"><strong>{data.queueEnabled ? "内部队列已开启" : "内部队列已关闭"}</strong><p>{data.publicGenerationEnabled ? "正式图片生成已配置开放，需邮箱登录、积分与配额；模型仍需供应商密钥及中继就绪。" : "正式图片生成尚未开放。"} 供应商实时余额与探测尚未接入。</p></div><Table headers={["模型", "供应商", "配置", "尝试", "成功", "异常", "最近调用"]} rows={items.map(item => [<span key={item.model}>{item.label}<small>{item.model}</small></span>, item.provider, item.configured ? "已配置" : "未配置", item.attempts, item.succeeded, item.failed, item.lastAttemptAt ? formatTime(item.lastAttemptAt) : "暂无"])} /></>;
}

function Analytics({ data }: { data: Data }) {
  const recharge = data.recharge as { status: string; users: number; amountFen: number }; const series = (data.series ?? []) as Array<{ day: string; pv: number; uv: number; averageDwellSeconds: number }>;
  return <><MetricGrid items={[["访问量 PV", Number(data.pv)],["访客数 UV", Number(data.uv)],["平均停留", duration(Number(data.averageDwellSeconds))],["有效样本", Number(data.dwellSamples)],["充值人数", recharge.users],["充值金额", `¥${(recharge.amountFen / 100).toFixed(2)}`]]} />{recharge.status !== "verified_ledger" && <div className="admin-notice"><strong>支付数据尚未接入</strong><p>充值数据尚未统计。</p></div>}{series.length ? <Table headers={["日期","PV","UV","平均停留"]} rows={series.map((row) => [row.day,String(row.pv),String(row.uv),duration(row.averageDwellSeconds)])} /> : <div className="state-panel">当前周期还没有访问数据。</div>}</>;
}

function Audit({ data }: { data: Data }) {
  const items = (data.items ?? []) as AuditEvent[];
  return items.length ? <Table headers={["来源","动作","操作人","目标","安全详情","时间"]} rows={items.map((item) => [item.source,item.action,<UserIdentifier key={item.actorId} id={item.actorId} />,<span key={item.targetId}>{item.targetType} · {item.targetType.toUpperCase() === "USER" || item.targetId.startsWith("user_") ? <UserIdentifier id={item.targetId} /> : item.targetId}</span>,<details className="admin-technical-detail" key="detail"><summary>查看详情</summary><p>{formatAuditDetail(item.detail)}</p></details>,formatTime(item.createdAt)])} /> : <div className="state-panel">当前没有符合条件的审计记录。</div>;
}

function MetricGrid({ items }: { items: Array<[string, string | number]> }) { return <div className="admin-metrics">{items.map(([label, value]) => <article key={label}><span>{label}</span><strong>{value ?? 0}</strong></article>)}</div>; }
function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) { return <div className="admin-table"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className={typeof cell === "number" || typeof cell === "string" && /^-?\d+(?:\.\d+)?$/.test(cell) ? "admin-numeric" : undefined}>{typeof cell === "string" && cell.length > 40 ? <details className="admin-technical-detail"><summary>{cell.slice(0, 24)}…</summary><p>{cell}</p></details> : cell}</td>)}</tr>)}</tbody></table></div>; }
async function adminMutation(method: "PATCH" | "POST", body: Record<string, unknown>) { const response = await fetch("/api/admin/console", { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const value = await response.json() as Data; if (!response.ok) throw new Error(apiMessage(value, "管理员操作失败。")); return value; }
function apiMessage(value: Data, fallback: string) { const error = value.error; return error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : fallback; }
function formatTime(seconds: number) { return seconds ? new Date(seconds * 1000).toLocaleString("zh-CN") : "—"; }
function formatIsoTime(value: string) { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN") : "—"; }
function duration(seconds: number) { const minutes = Math.floor(seconds / 60); return minutes ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`; }
function formatAuditDetail(detail: Record<string, unknown>) { const entries = Object.entries(detail); return entries.length ? entries.map(([key, value]) => `${key}: ${String(value)}`).join(" · ") : "—"; }
function consumerStatus(status: string) { return ({ ready: "正常", degraded: "异常", stale: "快照过期", unavailable: "不可用", disabled: "已关闭" } as Record<string, string>)[status] ?? "未知"; }
function queueAlertLabel(code: string) { return ({ CONSUMER_DEGRADED: "Consumer 状态异常", CONSUMER_STALE: "Consumer 健康快照已过期", CONSUMER_UNAVAILABLE: "无法读取 Consumer 健康状态", EXPIRED_LEASES: "存在过期租约", OPEN_RECONCILIATION: "存在待人工对账任务", UNPROCESSED_DEAD_LETTERS: "存在未处理死信", OBJECT_CLEANUP_BLOCKED: "存在阻塞的文件清理任务" } as Record<string, string>)[code] ?? code; }
