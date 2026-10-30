"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Native navigation matches the existing Vinext shell. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LEGAL_VERSION, safeReturnPath } from "@/lib/domain/legal";
import Image from "next/image";
import { WechatLogin } from "./WechatLogin";
import { responseMessage } from "@/components/site/api";

type Mode = "login" | "register" | "reset";
type EntryMode = Mode | "wechat";
const modeEvent = "zaoshi:auth-mode-change";
const MailIcon = () => <svg className="auth-input-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="1.7"/><path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const LockIcon = () => <svg className="auth-input-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="1.7"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg>;
const CodeIcon = () => <svg className="auth-input-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 5 6v5.5c0 4.4 3 8 7 9.5 4-1.5 7-5.1 7-9.5V6l-7-3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/><path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
const WechatIcon = () => <Image src="/auth/wechat-logo.png" width={32} height={32} alt="" unoptimized />;
function subscribeMode(callback: () => void) { window.addEventListener("popstate", callback); window.addEventListener(modeEvent, callback); return () => { window.removeEventListener("popstate", callback); window.removeEventListener(modeEvent, callback); }; }
function readMode(): EntryMode { const value = new URLSearchParams(window.location.search).get("mode"); return value === "register" || value === "reset" || value === "login" ? value : "wechat"; }
function setMode(value: EntryMode) { const url = new URL(window.location.href); url.searchParams.set("mode", value); window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); window.dispatchEvent(new Event(modeEvent)); }
export function EmailAuthView({ wechatReady = false }: { wechatReady?: boolean }) {
  const mode = useSyncExternalStore<EntryMode>(subscribeMode, readMode, () => "wechat");
  const [notice, setNotice] = useState("");
  const clientReady = useSyncExternalStore(subscribeMode, () => true, () => false);
  const oauthFailure = useSyncExternalStore(subscribeMode, () => new URLSearchParams(window.location.search).get("wechat"), () => null);
  function changeMode(value: Mode, resetComplete = false) { setNotice(resetComplete ? "密码已更新，请重新登录。" : ""); setMode(value); }
  if (mode === "wechat") return <AuthLayout><div className="auth-heading"><h1>登录你的设计空间</h1><p>使用微信扫码，继续你的空间创作。</p></div>{oauthFailure === "conflict" && <div className="auth-message auth-wechat-warning" role="alert"><strong>{oauthFailure === "conflict" ? "微信绑定未完成：该微信已属于另一个账户" : "微信登录未完成"}</strong><p>{oauthFailure === "conflict" ? "两个账户没有合并，积分、作品与订单仍分别保留。当前邮箱账户未退出，请返回个人资料继续使用。" : oauthFailure === "session" ? "登录状态已变化，请先登录邮箱账户后重新绑定。" : "请重新扫码或使用邮箱登录。"}</p>{oauthFailure === "conflict" && <><a href="/profile">返回当前邮箱账户的个人资料 →</a><p>如需切换账户，可选择下方操作，扫码确认后将登录该微信所属账户。</p><button className="auth-email-entry" type="button" onClick={() => { const url = new URL(window.location.href); url.searchParams.delete("wechat"); window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); setMode("wechat"); }}>使用该微信登录其原账户</button></>}</div>}{clientReady && oauthFailure !== "conflict" && <WechatLogin key={oauthFailure ?? "login"} enabled={wechatReady} initialError={oauthFailure ? oauthFailure === "session" ? "登录状态已变化，请先登录邮箱账户后重新绑定。" : "微信登录未完成，请刷新二维码或使用邮箱登录。" : undefined} />}<p className="wechat-login-gift"><span>新用户赠送<strong>350积分</strong>，<span className="wechat-login-gift-once">每个账户只享受一次。</span></span></p><div className="auth-divider" aria-hidden="true"><span>或</span></div><button className="auth-email-entry auth-email-entry--email" type="button" onClick={()=>setMode("login")}><MailIcon />使用邮箱登录</button><div className="wechat-login-footnotes"><p className="wechat-login-legal">已有邮箱账户？请先使用邮箱登录，再到个人资料绑定微信。</p></div></AuthLayout>;
  return <EmailAuthForm key={mode} mode={mode} initialMessage={mode === "login" ? notice : ""} changeMode={changeMode} />;
}
function EmailAuthForm({ mode, initialMessage, changeMode }: { mode: Mode; initialMessage: string; changeMode: (value: Mode, resetComplete?: boolean) => void }) {
  const [accepted, setAccepted] = useState(false);
  const [stage, setStage] = useState<"send" | "verify">("send");
  const [email, setEmail] = useState(""), [password, setPassword] = useState(""), [confirm, setConfirm] = useState(""), [code, setCode] = useState("");
  const [captcha, setCaptcha] = useState<{ id: string; svg: string }>(), [answer, setAnswer] = useState(""), [challengeId, setChallengeId] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(initialMessage);
  const generation = useRef(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const purpose = mode === "login" ? "login" : stage === "send" ? `${mode}-send` : mode;
  const refresh = useCallback(async () => {
    const current = ++generation.current; setCaptcha(undefined); setAnswer("");
    const response = await fetch(`/api/auth/email/captcha?purpose=${purpose}`, { cache: "no-store" });
    if (current !== generation.current) return;
    if (!response.ok) throw new Error(await responseMessage(response, "验证码暂时不可用。"));
    const value = await response.json() as { id: string; svg: string };
    if (current === generation.current) setCaptcha(value);
  }, [purpose]);
  useEffect(() => { let active = true; void Promise.resolve().then(refresh).catch((error: unknown) => { if (active) setMessage(error instanceof Error ? error.message : "验证码暂时不可用。"); }); return () => { active = false; generation.current += 1; }; }, [refresh]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy || !captcha) return;
    if (purpose === mode && mode !== "login" && password !== confirm) { setMessage("两次密码不一致。"); return; }
    if ((mode === "login" || mode === "register") && !accepted) { setMessage("请先阅读并同意用户协议和隐私政策。"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/auth/email/${purpose}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inviteCode: new URLSearchParams(window.location.search).get("invite"), email, password, code, challengeId, captchaId: captcha.id, captchaAnswer: answer, legal: { accepted, version: LEGAL_VERSION } }) });
      if (!active.current) return;
      if (!response.ok) throw new Error(await responseMessage(response, "登录请求失败，请重试。"));
      if (purpose.endsWith("-send")) { const value = await response.json() as { challengeId: string }; if (!active.current) return; setChallengeId(value.challengeId); setCaptcha(undefined); setStage("verify"); setMessage("验证码已发送，请检查邮箱。" ); }
      else if (mode === "reset") { changeMode("login", true); }
      else { const target = new URLSearchParams(window.location.search).get("returnTo"); window.location.assign(safeReturnPath(target)); }
    } catch (error) { if (!active.current) return; setMessage(error instanceof Error ? error.message : "登录请求失败，请重试。"); await refresh().catch(() => { if (active.current) setCaptcha(undefined); }); }
    finally { if (active.current) setBusy(false); }
  }
  function chooseMode(value: Mode) { setCaptcha(undefined); setAnswer(""); setMessage(""); changeMode(value); setStage("send"); setPassword(""); setConfirm(""); setCode(""); setChallengeId(""); }
  return <AuthLayout>
    <div className="auth-heading"><h1>{mode === "login" ? "邮箱登录" : mode === "register" ? "注册邮箱账户" : "找回密码"}</h1><p>{mode === "login" ? "登录你的造室账户。" : mode === "register" ? "新用户赠送350积分，每个账户只享受一次。" : "验证邮箱后设置新密码。"}</p></div>
    <div className="auth-tabs" role="group" aria-label="账户操作">{(["login", "register"] as const).map((value) => <button className={`secondary-button${mode === value ? " is-active" : ""}`} type="button" key={value} aria-pressed={mode === value} disabled={busy || mode === value} onClick={() => chooseMode(value)}>{value === "login" ? "登录" : "注册"}</button>)}</div>
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <label>邮箱<span className="auth-input"><MailIcon /><input type="email" autoComplete="email" required maxLength={254} placeholder="name@example.com" disabled={busy || stage === "verify"} value={email} onChange={(event) => setEmail(event.target.value)} /></span></label>
      {(mode === "login" || stage === "verify") && <>
        {mode !== "login" && <label>邮件验证码<span className="auth-input"><CodeIcon /><input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" placeholder="邮件中的六位数字" value={code} onChange={(event) => setCode(event.target.value)} /></span></label>}
        <div className="auth-field"><div className="auth-field-head"><label htmlFor="auth-password">密码（12–128字符）</label>{mode === "login" && <button className="auth-forgot-password" type="button" disabled={busy} onClick={() => chooseMode("reset")}>忘记密码？</button>}</div><span className="auth-input"><LockIcon /><input id="auth-password" type="password" minLength={12} maxLength={128} required autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="请输入密码" value={password} onChange={(event) => setPassword(event.target.value)} /></span></div>
        {mode !== "login" && <label>确认密码<span className="auth-input"><LockIcon /><input type="password" minLength={12} maxLength={128} required autoComplete="new-password" placeholder="再次输入密码" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></span></label>}
      </>}
      <div className="auth-captcha-field"><label htmlFor="auth-captcha-answer">图片中的六位数字</label><div className="auth-captcha"><input id="auth-captcha-answer" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="off" placeholder="输入右侧数字" value={answer} onChange={(event) => setAnswer(event.target.value)} /><span className="auth-captcha-image">{captcha && <Image unoptimized width={180} height={60} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(captcha.svg)}`} alt="六位数字图片验证码" />}</span><button className="secondary-button auth-captcha-refresh" type="button" aria-label="换一张" title="换一张" disabled={busy} onClick={() => void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "验证码暂时不可用。"))}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg></button></div></div>
      {(mode === "login" || mode === "register") && <label className="legal-checkbox"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} required disabled={busy} /><span>我已阅读并同意<a href="/terms" target="_blank" rel="noopener">用户协议</a>与<a href="/privacy" target="_blank" rel="noopener">隐私政策</a></span></label>}
      <button className="primary-button" type="submit" disabled={busy || !captcha}>{busy ? "处理中…" : purpose.endsWith("-send") ? "发送邮件验证码" : mode === "login" ? "登录" : mode === "register" ? "验证并注册" : "重置密码"}</button>
      <div className="auth-divider" aria-hidden="true"><span>或</span></div><button className="auth-email-entry auth-email-entry--wechat" type="button" disabled={busy} onClick={()=>setMode("wechat")}><span className="auth-wechat-icon"><WechatIcon /></span>返回微信登录</button>
      <p className="auth-message" role="status">{message}</p>
      {stage === "verify" && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setStage("send"); setCode(""); setChallengeId(""); }}>重新发送 / 修改邮箱</button>}
    </form>
  </AuthLayout>;
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="auth-page zs-auth"><aside className="auth-welcome"><Image className="auth-space-image" src="/auth/login-room.webp" alt="暖光下的现代简约客厅" width={1200} height={896} priority unoptimized/><div className="auth-welcome-top"><span className="auth-wordmark"><span className="brand-logo-mark" aria-hidden="true" />造室</span><a href="/">← 返回首页</a></div><div className="auth-welcome-copy"><span className="section-kicker">YOUR SPACE</span><h2>回到你的设计空间</h2><p>从灵感开始，让想法逐渐成形。</p><ul className="auth-welcome-tags" aria-label="造室能力"><li>风格灵感</li><li>局部重绘</li><li>多模型出图</li></ul></div></aside><section className="auth-panel">
{children}</section></div>;
}
