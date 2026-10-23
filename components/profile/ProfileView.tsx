"use client";

import { loadSession, useSession } from "@/components/site/session";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { responseMessage } from "@/components/site/api";
import { clearBrowserDrafts } from "@/components/studio/browser-drafts";

type MeSnapshot = {
  user: { authenticated: boolean; displayName: string; email?: string };
  authMode?: "demo" | "wechat" | "private-test" | "email";
  privateTest?: boolean;
  wechat?: { enabled: boolean; bound: boolean };
  isGalleryAdmin?: boolean;
  isSiteAdmin?: boolean;
  stats: { total: number; today: number; byKind: Record<string, number> };
  generationQuota?: { dailyLimit: number; usedToday: number; remainingToday: number; pending: number; pendingLimit: number; activeConcurrencyLimit: number; dailyUnlimited: boolean };
  persistence?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object"; }
function parseMe(value: unknown): MeSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.stats)) return undefined;
  const displayName = typeof value.user.displayName === "string" ? value.user.displayName : undefined;
  const total = typeof value.stats.total === "number" ? value.stats.total : undefined;
  const today = typeof value.stats.today === "number" ? value.stats.today : undefined;
  if (!displayName || total === undefined || today === undefined) return undefined;
  const byKind = isRecord(value.stats.byKind) ? Object.fromEntries(Object.entries(value.stats.byKind).filter((entry): entry is [string, number] => typeof entry[1] === "number")) : {};
  const rawQuota = isRecord(value.generationQuota) ? value.generationQuota : undefined;
  const quota = rawQuota && ["dailyLimit", "usedToday", "remainingToday", "pending", "pendingLimit", "activeConcurrencyLimit"].every((key) => typeof rawQuota[key] === "number") ? { ...rawQuota, dailyUnlimited: rawQuota.dailyUnlimited === true } as MeSnapshot["generationQuota"] : undefined;
  const authMode = value.authMode === "wechat" || value.authMode === "private-test" || value.authMode === "email" ? value.authMode : "demo";
  return {
    user: { authenticated: value.user.authenticated === true, displayName, ...(typeof value.user.email === "string" ? { email: value.user.email } : {}) },
    authMode,
    privateTest: value.privateTest === true,
    wechat: isRecord(value.wechat) ? { enabled: value.wechat.enabled === true, bound: value.wechat.bound === true } : undefined,
    isGalleryAdmin: value.isGalleryAdmin === true,
    isSiteAdmin: value.isSiteAdmin === true,
    stats: { total, today, byKind },
    generationQuota: quota,
    persistence: typeof value.persistence === "string" ? value.persistence : undefined,
  };
}

export function ProfileView({ compact = false, appearance }: { compact?: boolean; appearance?: ReactNode }) {
  const session = useSession();
  const [snapshot, setSnapshot] = useState<MeSnapshot>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const request = useRef(0);
  const logoutPending = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const load = useCallback(async () => {
    const current = ++request.current;
    setState("loading"); setError("");
    try {
      const parsed = parseMe(await loadSession());
      if (!parsed) throw new Error("个人资料格式无法识别。");
      if (current !== request.current) return;
      setSnapshot(parsed); setState("ready");
    } catch (reason) { if (current !== request.current) return; setError(reason instanceof Error ? reason.message : "个人资料暂时无法读取。"); setState("error"); }
  }, []);
  useEffect(() => { let active = true; Promise.resolve().then(() => { if (active) return load(); }); return () => { active = false; request.current += 1; }; }, [load]);

  async function logout() {
    if (logoutPending.current) return;
    logoutPending.current = true; setLoggingOut(true); setError("");
    const current = request.current;
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { Origin: window.location.origin } });
      if (!response.ok) throw new Error(await responseMessage(response, "退出失败，请重试。"));
      await clearBrowserDrafts(); window.location.reload();
    } catch (reason) { if (current === request.current) setError(reason instanceof Error ? reason.message : "退出失败，请重试。"); }
    finally { logoutPending.current = false; if (current === request.current) setLoggingOut(false); }
  }

  const identity = snapshot?.user.authenticated ? (snapshot.authMode === "wechat" ? "微信账户" : snapshot.authMode === "private-test" ? "付费私测账户" : "已登录账户") : "匿名会话";
  if (compact && state === "ready" && snapshot?.user.authenticated) return <div className="profile-page profile-compact profile-menu">
    <div className="profile-menu-identity"><span className="profile-menu-avatar" aria-hidden="true">{snapshot.user.displayName.slice(0, 1)}</span><div className="profile-menu-identity-copy"><div className="profile-menu-title"><h2>{snapshot.user.displayName}</h2>{snapshot.isSiteAdmin && <span className="profile-menu-role">超级管理员</span>}</div>{snapshot.user.email ? <a className="profile-menu-email" href={`mailto:${snapshot.user.email}`}>{snapshot.user.email}</a> : <p>{identity}</p>}{snapshot.authMode === "private-test" && snapshot.privateTest && <span className="status-pill">SSH 私测</span>}</div></div>
    {error && <div className="inline-notice error-text" role="alert">{error}</div>}
    <section className="profile-menu-credits" aria-label="积分"><div className="profile-menu-balance"><div><span>可用积分</span>{session?.credits ? <strong>{session.credits.available}</strong> : <span>余额暂不可用</span>}</div><a href="/products#recharge">积分与充值 <span aria-hidden="true">›</span></a></div>{session?.credits && <p>冻结积分 <b>{session.credits.reserved}</b></p>}</section>
    <section className="profile-menu-stats" aria-label="生成统计"><div><span>全部图片</span><strong>{snapshot.stats.total}</strong></div><div><span>今日图片</span><strong>{snapshot.stats.today}</strong></div><div><span>今日余量</span><strong>{snapshot.generationQuota?.dailyUnlimited ? "不限" : snapshot.generationQuota?.remainingToday ?? 0}</strong></div><div><span>待处理任务</span><strong>{snapshot.generationQuota ? `${snapshot.generationQuota.pending}/${snapshot.generationQuota.pendingLimit}` : "0/0"}</strong></div></section>
    <nav className="profile-menu-nav" aria-label="账户导航"><a href="/profile">查看完整资料 <span aria-hidden="true">›</span></a>{snapshot.isSiteAdmin && <a href="/admin">进入管理后台 <span aria-hidden="true">›</span></a>}</nav>
    {appearance}
    {(snapshot.authMode === "email" || snapshot.authMode === "wechat") && <button className="profile-menu-logout" type="button" disabled={loggingOut} onClick={() => void logout()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M10 4H5v16h5M9 12h12m-5-5 5 5-5 5" /></svg>{loggingOut ? "正在退出…" : "退出登录"}</button>}
  </div>;
  return <div className={compact ? "profile-page profile-compact" : "page-shell profile-page"}>
    {compact && appearance}
    {!compact && <header className="page-intro"><div><span className="section-kicker">PROFILE</span><h1>个人资料</h1></div></header>}
    {state === "loading" && <div className="state-panel profile-state" role="status">正在读取个人资料…</div>}
    {state === "error" && <div className="state-panel profile-state error" role="alert"><strong>资料读取失败</strong><p>{error}</p><button type="button" onClick={() => void load()}>重试</button></div>}
    {state === "ready" && snapshot && !snapshot.user.authenticated && <section className="profile-card guest-profile">
      <span className="profile-guest-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="7.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></span>
      <h2>尚未登录</h2><p>登录后查看你的账户和设计记录。</p>
      <div className="profile-account-actions">{snapshot.authMode === "email" && <><a className="primary-button" href="/login">登录</a><a className="secondary-button" href="/login?mode=register">注册</a></>}{snapshot.authMode === "wechat" && <a className="primary-button" href="/login">微信登录</a>}</div>
      {compact && <a className="profile-details-link" href="/profile">查看完整资料</a>}
    </section>}
    {state === "ready" && snapshot?.user.authenticated && <>
      <div className="profile-admin-row">{compact && <a className="profile-admin-link" href="/profile">查看完整资料</a>}{snapshot.isSiteAdmin && <a className="profile-admin-link" href="/admin">进入管理后台</a>}</div>
      {error && <div className="inline-notice error-text" role="alert">{error}</div>}
      {session?.credits && <section className="profile-card"><p className="profile-credit-balance"><span>可用积分 <strong>{session.credits.available}</strong></span><span>冻结 <b>{session.credits.reserved}</b></span></p><a href="/products#recharge">查看积分与充值</a></section>}
      <div className="profile-grid">
        <section className="profile-card identity-card"><span className="profile-avatar" aria-hidden="true">{snapshot.user.displayName.slice(0, 1)}</span><div><span className="section-kicker">ACCOUNT</span><h2>{snapshot.user.displayName}</h2><p>{snapshot.user.authenticated ? `已登录${identity}` : "当前为访客会话"}</p>{snapshot.user.email && <a className="profile-email" href={`mailto:${snapshot.user.email}`}>{snapshot.user.email}</a>}
          {snapshot.user.email && <div className="profile-wechat-binding"><strong>微信登录</strong><p>{snapshot.wechat?.bound ? "已绑定，可使用微信登录同一账户。" : "绑定后可用微信登录当前账户，保留积分、图片和权限。已有其他账户的微信无法绑定，账户不会自动合并。"}</p>{!snapshot.wechat?.bound && <form method="post" action="/api/auth/wechat/bind"><button className="secondary-button" type="submit" disabled={!snapshot.wechat?.enabled}>绑定微信</button></form>}{!snapshot.wechat?.enabled && <p>微信登录暂未开放。</p>}</div>}
          <div className="profile-account-actions">{(snapshot.authMode === "email" || snapshot.authMode === "wechat") && <button className="secondary-button" type="button" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? "正在退出…" : "退出登录"}</button>}</div>
          {snapshot.authMode === "private-test" && snapshot.privateTest && <span className="status-pill">SSH 私测</span>}
        </div></section>
        <section className="profile-card stats-card"><div><span>全部图片</span><strong>{snapshot.stats.total}</strong></div><div><span>今日图片</span><strong>{snapshot.stats.today}</strong></div><div><span>今日生成余量</span><strong>{snapshot.generationQuota?.dailyUnlimited ? "不限" : snapshot.generationQuota?.remainingToday ?? 0}</strong></div><div><span>待处理任务</span><strong>{snapshot.generationQuota ? `${snapshot.generationQuota.pending}/${snapshot.generationQuota.pendingLimit}` : "0/0"}</strong></div></section>
        {!compact && <section className="profile-card beta-card"><div><span className="section-kicker">PRIVATE BETA</span><h2>{snapshot.authMode === "private-test" ? "SSH 付费私测" : "收费与会员"}</h2></div><span className="status-pill">{snapshot.authMode === "private-test" ? "回环私测" : "内测 · 未启用"}</span><p>{snapshot.generationQuota?.dailyUnlimited ? "开发者私测无需充值积分、每日次数不限；每次只生成 1 张，须等待当前任务完成并确认供应商费用提示。" : snapshot.authMode === "private-test" ? "调试生图无需充值积分；每次仍须确认供应商 API 费用，并遵守每日张数与并发限制。" : "可用与冻结积分以服务端账本为准。真实支付尚在筹备；请勿向非正式渠道转账。"}</p></section>}
        {!compact && <section className="profile-card system-card"><h2>当前数据环境</h2><dl><div><dt>身份</dt><dd>{identity}</dd></div><div><dt>数据存储</dt><dd>{snapshot.persistence === "database" ? "数据库" : snapshot.persistence === "memory-demo" ? "本地演示内存" : snapshot.persistence ?? "服务端未说明"}</dd></div></dl><p>{snapshot.authMode === "private-test" ? "当前设备通过 SSH 回环隧道访问私测服务。" : snapshot.user.authenticated ? "登录会话由服务端保存，可在当前设备退出。" : "匿名会话依赖当前浏览器识别，不支持跨设备同步。"}</p></section>}
      </div>
    </>}
  </div>;
}
