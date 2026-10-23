"use client";
import { useEffect, useState, useSyncExternalStore } from "react";

function subscribeLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

const adminLinks = [
  ["/admin", "总览"],
  ["/admin/users", "用户"],
  ["/admin/credits", "积分"],
  ["/admin/recharge", "充值待对账"],
  ["/admin/tasks", "任务"],
  ["/admin/providers", "供应商"],
  ["/admin/analytics", "运营分析"],
  ["/admin/audit", "审计记录"],
  ["/admin/content", "图片维护"],
  ["/admin/gallery", "图库"],
  ["/admin/generation/reconciliation", "人工对账"],
  ["/admin/generation/dead-letters", "死信任务"],
] as const;

export function AdminShell({ children }: { children: React.ReactNode }) {
  const path = useSyncExternalStore(subscribeLocation, () => window.location.pathname, () => "");
  const [access, setAccess] = useState<"loading" | "anonymous" | "forbidden" | "allowed" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void fetch("/api/me", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("ACCOUNT_UNAVAILABLE");
      const me = await response.json() as { user?: { authenticated?: boolean }; isSiteAdmin?: boolean };
      if (active) setAccess(me.user?.authenticated !== true ? "anonymous" : me.isSiteAdmin === true ? "allowed" : "forbidden");
    }).catch(() => { if (active) setAccess("error"); });
    return () => { active = false; };
  }, [attempt]);
  if (access === "loading") return <div className="state-panel" role="status">正在确认管理员身份…</div>;
  if (access === "anonymous") return <div className="state-panel"><h1>请先登录管理员账户</h1><a className="primary-button" href="/login?mode=login">邮箱登录</a></div>;
  if (access === "forbidden") return <div className="state-panel" role="alert"><h1>没有管理员权限</h1><a className="secondary-button" href="/profile">返回个人资料</a></div>;
  if (access === "error") return <div className="state-panel" role="alert"><h1>管理员身份暂时无法确认</h1><button className="secondary-button" type="button" onClick={() => { setAccess("loading"); setAttempt((value) => value + 1); }}>重试</button></div>;
  return <div className="admin-shell"><aside className="admin-sidebar"><a className="admin-brand" href="/admin"><strong>造室</strong><span className="admin-brand-caption">管理后台</span></a><nav aria-label="管理员导航">{adminLinks.map(([href, label]) => <a key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</a>)}</nav><a className="admin-back" href="/profile">返回个人资料</a></aside><div className="admin-content">{children}</div></div>;
}
