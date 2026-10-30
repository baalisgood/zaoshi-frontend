"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Vinext currently fails with client next/link; native links keep navigation stable. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { AdminIcon, type AdminIconName } from "./AdminIcons";

function subscribeLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

type AlertKey = "reconciliation" | "dead_letters";
type NavItem = readonly [href: string, label: string, icon: AdminIconName, alert?: AlertKey];

// Order is kept identical to the original flat list; groups only add visual structure.
const adminGroups: ReadonlyArray<readonly [string, ReadonlyArray<NavItem>]> = [
  ["概览", [["/admin", "总览", "overview"]]],
  ["用户与积分", [["/admin/users", "用户", "users"], ["/admin/credits", "积分", "credits"], ["/admin/recharge", "充值待对账", "recharge"]]],
  ["生成服务", [["/admin/tasks", "任务", "tasks"], ["/admin/providers", "供应商", "providers"]]],
  ["数据与安全", [["/admin/analytics", "运营分析", "analytics"], ["/admin/audit", "审计记录", "audit"]]],
  ["内容", [["/admin/content", "图片维护", "content"], ["/admin/gallery", "图库", "gallery"]]],
  ["异常处理", [["/admin/generation/reconciliation", "人工对账", "reconciliation", "reconciliation"], ["/admin/generation/dead-letters", "死信任务", "deadLetters", "dead_letters"]]],
];

function AdminStateCard({ title, children, role }: { title: string; children?: React.ReactNode; role?: "status" | "alert" }) {
  return <div className="zs-admin-gate"><div className="zs-admin-gate-card" role={role}><span className="zs-admin-mark" aria-hidden="true">造</span><h1>{title}</h1>{children}</div></div>;
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const path = useSyncExternalStore(subscribeLocation, () => window.location.pathname, () => "");
  const [access, setAccess] = useState<"loading" | "anonymous" | "forbidden" | "allowed" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [alerts, setAlerts] = useState<Partial<Record<AlertKey, number>>>({});
  useEffect(() => {
    let active = true;
    void fetch("/api/me", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("ACCOUNT_UNAVAILABLE");
      const me = await response.json() as { user?: { authenticated?: boolean }; isSiteAdmin?: boolean };
      if (active) setAccess(me.user?.authenticated !== true ? "anonymous" : me.isSiteAdmin === true ? "allowed" : "forbidden");
    }).catch(() => { if (active) setAccess("error"); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    if (access !== "allowed") return;
    let active = true;
    // Badges are advisory only: failures keep the navigation usable without counts.
    const load = () => { if (document.visibilityState !== "visible") return; void fetch("/api/admin/console?view=alerts", { cache: "no-store", credentials: "same-origin" }).then(async (response) => { if (!response.ok) return; const body = await response.json() as { alerts?: Record<AlertKey, number> }; if (active && body.alerts) setAlerts(body.alerts); }).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [access, path]);
  if (access === "loading") return <AdminStateCard title="正在确认管理员身份…" role="status"><span className="zs-admin-spinner" aria-hidden="true" /></AdminStateCard>;
  if (access === "anonymous") return <AdminStateCard title="请先登录管理员账户"><p>管理后台仅对管理员开放。</p><a className="primary-button" href="/login?mode=login">邮箱登录</a></AdminStateCard>;
  if (access === "forbidden") return <AdminStateCard title="没有管理员权限" role="alert"><p>当前账户不是管理员，如需开通请联系站点负责人。</p><a className="secondary-button" href="/profile">返回个人资料</a></AdminStateCard>;
  if (access === "error") return <AdminStateCard title="管理员身份暂时无法确认" role="alert"><p>网络或服务暂时不可用，请稍后重试。</p><button className="secondary-button" type="button" onClick={() => { setAccess("loading"); setAttempt((value) => value + 1); }}>重试</button></AdminStateCard>;
  return <div className="admin-shell zs-admin"><aside className="admin-sidebar"><a className="admin-brand" href="/admin"><span className="zs-admin-mark" aria-hidden="true">造</span><span className="zs-admin-brand-text"><strong>造室</strong><span className="admin-brand-caption">管理后台</span></span></a><nav aria-label="管理员导航">{adminGroups.map(([group, items]) => <div className="zs-admin-nav-group" key={group}><span className="zs-admin-nav-label">{group}</span>{items.map(([href, label, icon, alert]) => { const count = alert ? alerts[alert] ?? 0 : 0; return <a key={href} href={href} aria-current={path === href ? "page" : undefined}><AdminIcon name={icon} /><span>{label}</span>{count > 0 && <b className="zs-admin-badge" aria-label={`${count} 条待处理`}>{count > 99 ? "99+" : count}</b>}</a>; })}</div>)}</nav><div className="zs-admin-sidebar-foot"><a className="admin-back" href="/profile"><AdminIcon name="back" />返回个人资料</a><a className="zs-admin-home" href="/"><AdminIcon name="home" />前台首页</a></div></aside><div className="admin-content">{children}</div></div>;
}
