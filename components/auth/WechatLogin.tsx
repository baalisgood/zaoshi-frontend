"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Image from "next/image";
import { safeReturnPath } from "@/lib/domain/legal";
import { startEmbeddedWechatLogin } from "./wechat-login-start";

type LoginOptions = {
  id: string; appid: string; scope: string; redirect_uri: string; state: string;
  self_redirect: false; onQRcodeReady: () => void; onCleanup?: () => void;
};
declare global { interface Window { WxLogin?: new (options: LoginOptions) => unknown } }

export function WechatLogin({ enabled, initialError }: { enabled: boolean; initialError?: string }) {
  const id = useId();
  const mount = useRef<HTMLDivElement>(null);
  const consentFocus = useRef<{ node: Element; index: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(initialError ? "error" : "idle");
  const [message, setMessage] = useState(initialError ?? "");
  useLayoutEffect(() => {
    const previous = consentFocus.current;
    consentFocus.current = null;
    if (previous && !previous.node.isConnected && document.activeElement === document.body) {
      mount.current?.closest(".wechat-login-entry")?.querySelectorAll<HTMLElement>(".wechat-login-consent input, .wechat-login-consent a")[previous.index]?.focus();
    }
  }, [status]);
  useEffect(() => {
    if (!enabled || !accepted || !started) return;
    let active = true;
    let options: LoginOptions | undefined;
    let resize: ResizeObserver | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const container = mount.current;
    const script = document.createElement("script");
    const clearFrame = () => { resize?.disconnect(); options?.onCleanup?.(); container?.replaceChildren(); };
    const showStatus = (next: "ready" | "error") => {
      const focused = document.activeElement;
      const consent = container?.closest(".wechat-login-entry")?.querySelector(".wechat-login-consent");
      const focusIndex = consent ? Array.from(consent.querySelectorAll("input, a")).indexOf(focused as Element) : -1;
      consentFocus.current = focusIndex >= 0 && focused ? { node: focused, index: focusIndex } : null;
      setStatus(next);
    };
    const fail = (text: string) => {
      if (!active) return;
      active = false;
      clearTimeout(timeout);
      clearTimeout(expiry);
      clearFrame();
      setMessage(text);
      showStatus("error");
    };
    const timeout = setTimeout(() => fail("微信二维码加载超时，请检查网络后重试。"), 20_000);
    async function load() {
      try {
        const returnTo = safeReturnPath(new URLSearchParams(window.location.search).get("returnTo"));
        const data = await startEmbeddedWechatLogin(returnTo, new URLSearchParams(window.location.search).get("invite") ?? "");
        if (!active) return;
        if (!Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) throw new Error("二维码已过期，请刷新后重新扫码。");
        expiry = setTimeout(() => fail("二维码已过期，请刷新后重新扫码。"), data.expiresAt - Date.now());
        if (!window.WxLogin) await new Promise<void>((resolve, reject) => {
          script.src = "https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js";
          script.async = true;
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("微信登录组件加载失败，请检查网络后重试。"));
          document.head.appendChild(script);
        });
        if (!active) return;
        if (!window.WxLogin) throw new Error("微信登录组件不可用，请重试。");
        options = {
          id, appid: data.appid, scope: data.scope, redirect_uri: encodeURIComponent(data.redirect_uri), state: data.state,
          self_redirect: false,
          onQRcodeReady: () => { if (active) { clearTimeout(timeout); showStatus("ready"); } },
        };
        new window.WxLogin(options);
        const frame = container?.querySelector("iframe");
        if (frame && container) {
          frame.title = "微信扫码登录二维码";
          const fit = () => {
            const scale = Math.min(1, container.clientWidth / 300);
            frame.style.transform = `scale(${scale})`;
            container.style.height = `${400 * scale}px`;
          };
          resize = new ResizeObserver(fit);
          resize.observe(container);
          fit();
        }
      } catch (error) {
        if (active) fail(error instanceof Error ? error.message : "二维码加载失败，请重试。");
      }
    }
    void load();
    return () => { active = false; clearTimeout(timeout); clearTimeout(expiry); script.onload = null; script.onerror = null; script.remove(); clearFrame(); };
  }, [enabled, accepted, started, attempt, id]);

  const consentControl = <label className="legal-checkbox wechat-login-consent"><input type="checkbox" checked={accepted} onChange={event => { setAccepted(event.target.checked); if (!event.target.checked) { setStarted(false); setStatus("idle"); setMessage(""); requestAnimationFrame(() => mount.current?.closest(".wechat-login-entry")?.querySelector<HTMLInputElement>("input[type=checkbox]")?.focus()); } }} /><span>我已阅读并同意<a href="/terms" target="_blank" rel="noopener">《用户协议》</a>和<a href="/privacy" target="_blank" rel="noopener">《隐私政策》</a></span></label>;

  return <div className="wechat-login-entry">
    {!enabled ? <p className="wechat-login-note">微信登录暂未配置，请使用邮箱登录。</p> : <>

      <div className="wechat-login-qr">
        <div ref={mount} id={id} />
        {status !== "ready" && <div className="wechat-login-status"><div className="wechat-login-intro"><Image src="/auth/wechat-logo.png" width={56} height={56} alt="微信" unoptimized /><strong>微信扫码登录</strong></div><p className="wechat-login-note" role={status === "error" ? "alert" : "status"}>{status === "error" ? message : status === "idle" ? "使用微信扫一扫，在手机上确认登录。" : "正在加载微信二维码…"}</p>{consentControl}{(status === "idle" || status === "error") && <button className="wechat-login-button" type="button" disabled={!accepted} onClick={() => { if (!accepted) return; setStarted(true); setStatus("loading"); setMessage(""); setAttempt(value => value + 1); }}>{status === "error" ? "刷新二维码" : "开始微信扫码"}</button>}</div>}
      </div>
      {status === "ready" && consentControl}
    </>}
  </div>;
}
