"use client";

import { ReferralPanel, type ReferralSummary } from "./ReferralPanel";
import { loadSession, useSession } from "@/components/site/session";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { responseMessage } from "@/components/site/api";
import { clearBrowserDrafts } from "@/components/studio/browser-drafts";

type MeSnapshot = {
  user: { authenticated: boolean; displayName: string; email?: string };
  authMode?: "demo" | "wechat" | "private-test" | "email";
  privateTest?: boolean;
  referral?: ReferralSummary | null;
  wechat?: { enabled: boolean; bound: boolean };
  isGalleryAdmin?: boolean;
  isSiteAdmin?: boolean;
  stats: { total: number; today: number; byKind: Record<string, number> };
  generationQuota?: { dailyLimit: number | null; usedToday: number; remainingToday: number | null; pending: number; pendingLimit: number; activeConcurrencyLimit: number; dailyUnlimited: boolean };
  persistence?: string;
};

const icon = (path: ReactNode) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>;
const icons = {
  image: icon(<><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="m4.5 17 4.8-4.6 3.4 3.1 2.6-2.4 4.2 3.9" /></>),
  clock: icon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  chart: icon(<><path d="M4 19.5h16" /><path d="M7 16v-5M12 16V6M17 16v-8" /></>),
  queue: icon(<path d="M12 5v14M5 12h14" />),
  mail: icon(<><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m4 7 8 6 8-6" /></>),
  wechat: <svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M21 14c0 5-4 9-10 9l-6 3 1-5C3 19 2 17 2 14c0-5 4-9 10-9s9 4 9 9Z" /><path d="M30 21c0 4-3 7-8 7l-4 2v-4c-3-1-4-3-4-5 0-4 3-7 8-7s8 3 8 7Z" stroke="var(--zs-wechat-soft,#e8f8ef)" strokeWidth="1.4" /></svg>,
  session: icon(<path d="M10 4H5v16h5M9 12h11m-4-4 4 4-4 4" />),
  user: icon(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>),
  admin: icon(<><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>),
};
const formatCount = (value: number) => value.toLocaleString("zh-CN");

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object"; }
function parseMe(value: unknown): MeSnapshot | undefined {
  if (!isRecord(value) || !isRecord(value.user) || !isRecord(value.stats)) return undefined;
  const displayName = typeof value.user.displayName === "string" ? value.user.displayName : undefined;
  const total = typeof value.stats.total === "number" ? value.stats.total : undefined;
  const today = typeof value.stats.today === "number" ? value.stats.today : undefined;
  if (!displayName || total === undefined || today === undefined) return undefined;
  const byKind = isRecord(value.stats.byKind) ? Object.fromEntries(Object.entries(value.stats.byKind).filter((entry): entry is [string, number] => typeof entry[1] === "number")) : {};
  const rawQuota = isRecord(value.generationQuota) ? value.generationQuota : undefined;
  const quota = rawQuota && ["usedToday", "pending", "pendingLimit", "activeConcurrencyLimit"].every((key) => typeof rawQuota[key] === "number") ? { ...rawQuota, dailyUnlimited: rawQuota.dailyUnlimited === true } as MeSnapshot["generationQuota"] : undefined;
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
    referral: isRecord(value.referral) && Array.isArray(value.referral.invitees) ? value.referral as ReferralSummary : null,
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
  const [payment, setPayment] = useState<{ scope?: string; status: "loading" | "enabled" | "disabled" | "error" }>({ status: "loading" });
  const paymentScope = session?.draftScope;
  const checkPayment = !compact && Boolean(paymentScope) && session?.user.authenticated === true && session.authMode !== "private-test" && !session.privateTest;
  useEffect(() => {
    if (!checkPayment || !paymentScope) return;
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      if (active) { active = false; setPayment({ scope: paymentScope, status: "error" }); }
    }, 8000);
    void Promise.resolve().then(async () => {
      if (!active) return;
      setPayment({ scope: paymentScope, status: "loading" });
      const response = await fetch("/api/recharge/catalog", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("充值状态暂不可用。");
      const catalog: unknown = await response.json();
      if (!isRecord(catalog) || typeof catalog.enabled !== "boolean") throw new Error("充值状态格式无法识别。");
      if (active) setPayment({ scope: paymentScope, status: catalog.enabled ? "enabled" : "disabled" });
    }).catch(() => { if (active) setPayment({ scope: paymentScope, status: "error" }); }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [checkPayment, paymentScope]);
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

  const loginMethod = snapshot?.authMode === "email" ? "邮箱登录" : snapshot?.authMode === "wechat" ? "微信登录" : snapshot?.authMode === "private-test" ? "SSH 私测登录" : "演示会话";
  const identity = snapshot?.user.authenticated ? (snapshot.authMode === "wechat" ? "微信账户" : snapshot.authMode === "private-test" ? "付费私测账户" : "已登录账户") : "匿名会话";
  const paymentCopy = {
    loading: { badge: "正在确认", text: "正在确认充值开放状态。可用与冻结积分以服务端账本为准。" },
    enabled: { badge: "充值已开放", text: "支持微信扫码充值，请前往积分与充值查看当前套餐和订单状态。可用与冻结积分以服务端账本为准。" },
    disabled: { badge: "充值暂未开放", text: "当前暂未开放充值。可用与冻结积分以服务端账本为准；请勿向非正式渠道转账。" },
    error: { badge: "暂时无法确认", text: "暂时无法确认充值状态，请稍后重试或前往积分与充值查看。可用与冻结积分以服务端账本为准。" },
  }[payment.scope === paymentScope ? payment.status : "loading"];
  if (compact && state === "ready" && snapshot?.user.authenticated) return <div className="profile-page profile-compact profile-menu">
    <div className="profile-menu-identity"><span className="profile-menu-avatar" aria-hidden="true">{snapshot.user.displayName.slice(0, 1)}</span><div className="profile-menu-identity-copy"><div className="profile-menu-title"><h2>{snapshot.user.displayName}</h2>{snapshot.isSiteAdmin && <span className="profile-menu-role">超级管理员</span>}</div>{snapshot.user.email ? <a className="profile-menu-email" href={`mailto:${snapshot.user.email}`}>{snapshot.user.email}</a> : <p>{identity}</p>}{snapshot.authMode === "private-test" && snapshot.privateTest && <span className="status-pill">SSH 私测</span>}</div></div>
    {error && <div className="inline-notice error-text" role="alert">{error}</div>}
    <section className="profile-menu-credits" aria-label="积分"><div className="profile-menu-balance"><div><span>可用积分</span>{session?.credits ? <strong>{formatCount(session.credits.available)}</strong> : <span>余额暂不可用</span>}</div><a href="/products#recharge">积分与充值 <span aria-hidden="true">›</span></a></div>{session?.credits && <p>冻结积分 <b>{formatCount(session.credits.reserved)}</b></p>}</section>
    <section className="profile-menu-stats" aria-label="生成统计"><div><span>全部图片</span><strong>{snapshot.stats.total}</strong></div><div><span>今日图片</span><strong>{snapshot.stats.today}</strong></div><div><span>今日余量</span><strong>{snapshot.generationQuota?.dailyUnlimited ? "不限" : snapshot.generationQuota?.remainingToday ?? 0}</strong></div><div><span>待处理任务</span><strong>{snapshot.generationQuota ? `${snapshot.generationQuota.pending}/${snapshot.generationQuota.pendingLimit}` : "0/0"}</strong></div></section>
    <nav className="profile-menu-nav" aria-label="账户导航"><a href="/profile">{icons.user}<span>查看完整资料</span> <span className="profile-menu-chevron" aria-hidden="true">›</span></a>{snapshot.isSiteAdmin && <a href="/admin">{icons.admin}<span>进入管理后台</span> <span className="profile-menu-chevron" aria-hidden="true">›</span></a>}</nav>
    {appearance}
    {(snapshot.authMode === "email" || snapshot.authMode === "wechat") && <button className="profile-menu-logout" type="button" disabled={loggingOut} onClick={() => void logout()}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M10 4H5v16h5M9 12h12m-5-5 5 5-5 5" /></svg>{loggingOut ? "正在退出…" : "退出登录"}</button>}
  </div>;
  if (compact && state === "ready" && snapshot && !snapshot.user.authenticated) return <div className="profile-menu profile-menu-guest">
    <section className="profile-menu-identity" aria-label="账户概览"><span className="profile-menu-avatar" aria-hidden="true">{icons.user}</span><div className="profile-menu-identity-copy"><div className="profile-menu-title"><h2>尚未登录</h2></div><p>登录后查看你的账户和设计记录。</p></div></section>
    {(snapshot.authMode === "email" || snapshot.authMode === "wechat") && <div className="profile-menu-guest-actions"><a className="primary-button" href="/login">{snapshot.authMode === "wechat" ? "微信登录" : "登录"}</a>{snapshot.authMode === "email" && <a className="secondary-button" href="/login?mode=register">注册</a>}</div>}
    <nav className="profile-menu-nav" aria-label="账户导航"><a href="/profile">{icons.user}<span>查看完整资料</span><span className="profile-menu-chevron" aria-hidden="true">›</span></a></nav>
    {appearance}
  </div>;
  return <div className={compact ? "profile-page profile-compact" : "page-shell profile-page zs-profile"}>
    {compact && appearance}
    {!compact && <header className="page-intro"><div><span className="section-kicker">PROFILE</span><h1>个人资料</h1><p className="profile-intro-note">管理你的账户、积分与登录方式。</p></div></header>}
    {state === "loading" && <div className="state-panel profile-state" role="status">正在读取个人资料…</div>}
    {state === "error" && <div className="state-panel profile-state error" role="alert"><strong>资料读取失败</strong><p>{error}</p><button type="button" onClick={() => void load()}>重试</button></div>}
    {state === "ready" && snapshot && !snapshot.user.authenticated && <section className="profile-card guest-profile">
      <span className="profile-guest-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="7.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></span>
      <h2>尚未登录</h2><p>登录后查看你的账户和设计记录。</p>
      <div className="profile-account-actions">{snapshot.authMode === "email" && <><a className="primary-button" href="/login">登录</a><a className="secondary-button" href="/login?mode=register">注册</a></>}{snapshot.authMode === "wechat" && <a className="primary-button" href="/login">微信登录</a>}</div>
      {compact && <a className="profile-details-link" href="/profile">查看完整资料</a>}
    </section>}
    {state === "ready" && snapshot?.user.authenticated && <>
      {error && <div className="inline-notice error-text" role="alert">{error}</div>}
      <section className="profile-hero" aria-label="账户概览">
        <div className="profile-hero-identity"><span className="profile-avatar" aria-hidden="true">{snapshot.user.displayName.slice(0, 1)}</span><div className="profile-hero-copy"><div className="profile-hero-name"><h2>{snapshot.user.displayName}</h2><span className="profile-identity-pill">{identity}</span>{snapshot.isSiteAdmin && <span className="profile-identity-pill is-admin">超级管理员</span>}{snapshot.authMode === "private-test" && snapshot.privateTest && <span className="status-pill">SSH 私测</span>}</div><div className="profile-hero-meta">{snapshot.user.email && <><a className="profile-email" href={`mailto:${snapshot.user.email}`}>{snapshot.user.email}</a><span className="profile-meta-dot" aria-hidden="true" /></>}<span>{loginMethod}</span></div></div></div>
        {session?.credits && <div className="profile-wallet"><div><small>可用积分</small><strong>{formatCount(session.credits.available)}</strong></div><div className="profile-wallet-frozen"><small>冻结</small><b>{formatCount(session.credits.reserved)}</b></div><a href="/products#recharge">查看积分与充值 <span aria-hidden="true">→</span></a></div>}
      </section>
      <section className="profile-stats" aria-label="生成统计">
        <div className="profile-stat"><span className="profile-stat-label"><i>{icons.image}</i>全部图片</span><strong>{formatCount(snapshot.stats.total)}<small>张</small></strong></div>
        <div className="profile-stat"><span className="profile-stat-label"><i>{icons.clock}</i>今日图片</span><strong>{formatCount(snapshot.stats.today)}<small>张</small></strong></div>
        <div className="profile-stat"><span className="profile-stat-label"><i>{icons.chart}</i>今日生成余量</span><strong>{snapshot.generationQuota?.dailyUnlimited ? "不限" : snapshot.generationQuota?.remainingToday ?? 0}</strong></div>
        <div className="profile-stat"><span className="profile-stat-label"><i>{icons.queue}</i>待处理任务</span><strong>{snapshot.generationQuota ? snapshot.generationQuota.pending : 0}<small>/ {snapshot.generationQuota ? snapshot.generationQuota.pendingLimit : 0}</small></strong></div>
      </section>
      {snapshot.referral && <ReferralPanel key={session?.draftScope} summary={snapshot.referral} />}
      <div className="profile-columns">
        <section className="profile-card profile-settings"><h2>账户与登录</h2><p className="profile-card-note">登录方式与会话管理。</p>
          <div className="profile-setting-list">
            {snapshot.user.email && <div className="profile-setting-row"><span className="profile-setting-icon">{icons.mail}</span><div className="profile-setting-copy"><strong>邮箱</strong><span>{snapshot.user.email}</span></div></div>}
            {snapshot.user.email && <div className="profile-setting-row profile-wechat-binding"><span className="profile-setting-icon is-wechat">{icons.wechat}</span><div className="profile-setting-copy"><strong>微信登录</strong><span>{snapshot.wechat?.bound ? "已绑定，可使用微信登录同一账户。" : "绑定后可用微信登录当前账户，保留积分、图片和权限。已有其他账户的微信无法绑定，账户不会自动合并。"}{!snapshot.wechat?.enabled && "微信登录暂未开放。"}</span></div>{!snapshot.wechat?.bound && <form method="post" action="/api/auth/wechat/bind"><button className="secondary-button" type="submit" disabled={!snapshot.wechat?.enabled}>绑定微信</button></form>}</div>}
            {!snapshot.user.email && snapshot.authMode === "wechat" && <div className="profile-setting-row"><span className="profile-setting-icon is-wechat">{icons.wechat}</span><div className="profile-setting-copy"><strong>微信登录</strong><span>当前账户使用微信登录。</span></div></div>}
            <div className="profile-setting-row"><span className="profile-setting-icon">{icons.session}</span><div className="profile-setting-copy"><strong>登录会话</strong><span>{snapshot.authMode === "private-test" ? "当前设备通过 SSH 回环隧道访问私测服务。" : snapshot.user.authenticated ? "登录会话由服务端保存，可在当前设备退出。" : "匿名会话依赖当前浏览器识别，不支持跨设备同步。"}</span></div>{(snapshot.authMode === "email" || snapshot.authMode === "wechat") && <button className="secondary-button profile-logout-button" type="button" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? "正在退出…" : "退出登录"}</button>}</div>
            {snapshot.isSiteAdmin && <div className="profile-setting-row"><span className="profile-setting-icon">{icons.admin}</span><div className="profile-setting-copy"><strong>管理后台</strong><span>管理用户、积分、任务与内容。</span></div><a className="secondary-button profile-admin-link" href="/admin">进入管理后台</a></div>}
          </div>
        </section>
        <div className="profile-side">
          <section className="profile-card beta-card"><div><span className="section-kicker">PRIVATE BETA</span><h2>{snapshot.authMode === "private-test" ? "SSH 付费私测" : "收费与会员"}</h2></div><span className="status-pill">{snapshot.authMode === "private-test" ? "回环私测" : paymentCopy.badge}</span><p>{snapshot.privateTest ? "开发者私测无需充值积分、每日次数不限；每次只生成 1 张，须等待当前任务完成并确认供应商费用提示。" : snapshot.authMode === "private-test" ? "调试生图无需充值积分；每次仍须确认供应商 API 费用，并遵守每日张数与并发限制。" : paymentCopy.text}</p></section>
          <section className="profile-card system-card"><h2>当前数据环境</h2><dl><div><dt>身份</dt><dd>{identity}</dd></div><div><dt>数据存储</dt><dd>{snapshot.persistence === "database" ? "数据库" : snapshot.persistence === "memory-demo" ? "本地演示内存" : snapshot.persistence ?? "服务端未说明"}</dd></div></dl></section>
        </div>
      </div>
    </>}
  </div>;
}
