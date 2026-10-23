"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- Native navigation matches the existing Vinext shell. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LEGAL_VERSION, safeReturnPath } from "@/lib/domain/legal";
import Image from "next/image";
import { responseMessage } from "@/components/site/api";

type Mode = "login" | "register" | "reset";
type EntryMode = Mode | "wechat";
const modeEvent = "zaoshi:auth-mode-change";
function subscribeMode(callback: () => void) { window.addEventListener("popstate", callback); window.addEventListener(modeEvent, callback); return () => { window.removeEventListener("popstate", callback); window.removeEventListener(modeEvent, callback); }; }
function readMode(): EntryMode { const value = new URLSearchParams(window.location.search).get("mode"); return value === "register" || value === "reset" || value === "login" ? value : "wechat"; }
function setMode(value: EntryMode) { const url = new URL(window.location.href); url.searchParams.set("mode", value); window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`); window.dispatchEvent(new Event(modeEvent)); }
export function EmailAuthView({ wechatReady = false }: { wechatReady?: boolean }) {
  const mode = useSyncExternalStore<EntryMode>(subscribeMode, readMode, () => "wechat");
  const [notice, setNotice] = useState("");
  const oauthFailure = useSyncExternalStore(subscribeMode, () => new URLSearchParams(window.location.search).get("wechat"), () => null);
  function changeMode(value: Mode, resetComplete = false) { setNotice(resetComplete ? "密码已更新，请重新登录。" : ""); setMode(value); }
  if (mode === "wechat") return <AuthLayout><div className="auth-heading"><h1>登录你的设计空间</h1><p>使用微信扫码，继续你的空间创作。</p></div>{oauthFailure && <p className="auth-message" role="alert">{oauthFailure === "conflict" ? "该微信已属于其他账户，未进行绑定或合并。请登录原账户。" : oauthFailure === "session" ? "登录状态已变化，请先登录邮箱账户后重新绑定。" : "微信登录未完成，请重新扫码或使用邮箱登录。"}</p>}<div className="wechat-login-entry"><span className="wechat-login-symbol" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M21 14c0 5-4 9-10 9l-6 3 1-5C3 19 2 17 2 14c0-5 4-9 10-9s9 4 9 9Z" fill="currentColor"/><path d="M30 21c0 4-3 7-8 7l-4 2v-4c-3-1-4-3-4-5 0-4 3-7 8-7s8 3 8 7Z" fill="currentColor" stroke="var(--paper)" strokeWidth="1.4"/><circle cx="8" cy="12" r="1" fill="white"/><circle cx="15" cy="12" r="1" fill="white"/><circle cx="19" cy="20" r="1" fill="white"/><circle cx="25" cy="20" r="1" fill="white"/></svg></span><button className="wechat-login-button" type="button" disabled={!wechatReady} onClick={()=>{const target = new URLSearchParams(window.location.search).get("returnTo"); window.location.assign(`/api/auth/wechat/start?returnTo=${encodeURIComponent(safeReturnPath(target))}`);}}>微信扫码登录</button><p className="wechat-login-note">{wechatReady ? "前往微信安全登录页面，扫码并确认后返回造室。" : "微信登录暂未配置，请使用邮箱登录。"}</p><p className="wechat-login-note">首次微信注册并完成协议确认，赠送350积分；每个新账户一次。</p><p className="wechat-login-legal">登录后需阅读并确认<a href="/terms">用户协议</a>与<a href="/privacy">隐私政策</a>。</p></div><button className="auth-email-entry" type="button" onClick={()=>setMode("login")}>使用邮箱登录 <span aria-hidden="true">→</span></button><p className="wechat-login-legal">已有邮箱账户？请先使用邮箱登录，再到个人资料绑定微信。</p></AuthLayout>;
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
    if (mode === "register" && !accepted) { setMessage("请先阅读并同意用户协议和隐私政策。"); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/auth/email/${purpose}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, code, challengeId, captchaId: captcha.id, captchaAnswer: answer, legal: { accepted, version: LEGAL_VERSION } }) });
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
    <div className="auth-heading"><span className="section-kicker">ACCOUNT</span><h1>{mode === "login" ? "邮箱登录" : mode === "register" ? "注册邮箱账户" : "找回密码"}</h1><p>{mode === "login" ? "登录你的造室账户。" : mode === "register" ? "验证邮箱，创建你的账户。新用户注册成功获350积分，每个账户赠送一次。" : "验证邮箱后设置新密码。"}</p></div>
    <div className="auth-tabs" aria-label="账户操作">{(["login", "register"] as const).map((value) => <button className="secondary-button" type="button" key={value} disabled={busy || mode === value} onClick={() => chooseMode(value)}>{value === "login" ? "登录" : "注册"}</button>)}</div>
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <label>邮箱<input type="email" autoComplete="email" required maxLength={254} disabled={busy || stage === "verify"} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      {(mode === "login" || stage === "verify") && <>
        {mode !== "login" && <label>邮件验证码<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} /></label>}
        <label>密码（12–128字符）<input type="password" minLength={12} maxLength={128} required autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {mode !== "login" && <label>确认密码<input type="password" minLength={12} maxLength={128} required autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>}
      </>}
      {mode === "login" && <button className="auth-forgot-password" type="button" disabled={busy} onClick={() => chooseMode("reset")}>忘记密码？</button>}
      <div className="auth-captcha-field"><label htmlFor="auth-captcha-answer">图片中的六位数字</label><div className="auth-captcha"><span className="auth-captcha-image">{captcha && <Image unoptimized width={180} height={60} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(captcha.svg)}`} alt="六位数字图片验证码" />}</span><button className="secondary-button" type="button" disabled={busy} onClick={() => void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "验证码暂时不可用。"))}>换一张</button><input id="auth-captcha-answer" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="off" value={answer} onChange={(event) => setAnswer(event.target.value)} /></div></div>
      {mode === "register" && <label className="legal-checkbox"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} required disabled={busy} /><span>我已阅读并同意<a href="/terms" target="_blank" rel="noopener">用户协议</a>与<a href="/privacy" target="_blank" rel="noopener">隐私政策</a></span></label>}
      <button className="primary-button" type="submit" disabled={busy || !captcha}>{busy ? "处理中…" : purpose.endsWith("-send") ? "发送邮件验证码" : mode === "login" ? "登录" : mode === "register" ? "验证并注册" : "重置密码"}</button>
      <button className="auth-email-entry" type="button" disabled={busy} onClick={()=>setMode("wechat")}>返回微信登录</button>
      <p className="auth-message" role="status">{message}</p>
      {stage === "verify" && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setStage("send"); setCode(""); setChallengeId(""); }}>重新发送 / 修改邮箱</button>}
    </form>
  </AuthLayout>;
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="auth-page"><aside className="auth-welcome"><span className="auth-wordmark">造室</span><Image className="auth-space-image" src="/demo/scene.svg" alt="现代简约空间灵感" width={640} height={400} unoptimized/><div><span className="section-kicker">YOUR SPACE</span><h2>回到你的设计空间</h2><p>从灵感开始，让想法逐渐成形。</p></div><a href="/">返回首页 ↗</a></aside><section className="auth-panel">
{children}</section></div>;
}
