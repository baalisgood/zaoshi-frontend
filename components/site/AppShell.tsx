"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- Vinext currently fails with client next/link; native links keep navigation stable. */

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSession, loadSession } from "@/components/site/session";
import { ProfileView } from "@/components/profile/ProfileView";
import { AnalyticsTracker } from "@/components/site/AnalyticsTracker";
import { recoverPendingSubmissions, shouldRecoverPendingSubmissions, syncBrowserDraftScope } from "@/components/studio/browser-drafts";

const navItems = [
  { href: "/", label: "首页" },
  { href: "/studio", label: "智能工作台" },
  { href: "/pro", label: "高级工作台" },
  { href: "/self-service", label: "自助工作台" },
  { href: "/products", label: "产品与价格" },
];

const themeEvent = "zaoshi:theme-change";
let sessionTheme: "light" | "dark" | null = null;

function getThemeSnapshot(): "light" | "dark" {
  if (sessionTheme) return sessionTheme;
  try {
    const saved = window.localStorage.getItem("zaoshi-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* Fall through to the system preference. */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribeToTheme(callback: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = () => { sessionTheme = null; callback(); };
  window.addEventListener(themeEvent, callback);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", callback);
  return () => {
    window.removeEventListener(themeEvent, callback);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", callback);
  };
}

function isActive(href: string, path: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

function subscribeToLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

export function AppShell({ children }: { children: React.ReactNode; initialEmailEntry?: boolean }) {
  const path = useSyncExternalStore(subscribeToLocation, () => window.location.pathname, () => "");
  const theme = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, () => "light");
  const [headerHidden, setHeaderHidden] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const account = useSession();
  const openedByHover = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeButton = useRef<HTMLButtonElement>(null);
  const avatarButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  const lastScrollY = useRef(0);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => { let active = true; void syncBrowserDraftScope().then(async changed => { if (!active) return; if (changed) { window.location.reload(); return; } const me = await loadSession(); if (shouldRecoverPendingSubmissions(window.location.origin, true, me.authMode)) await recoverPendingSubmissions(); }).catch(() => undefined); return () => { active = false; }; }, []);

  useEffect(() => {
    if (drawerOpen) return;
    let frame = 0;
    const updateFromScroll = () => {
      frame = 0;
      const current = window.scrollY;
      if (current <= 16) setHeaderHidden(false);
      else if (Math.abs(current - lastScrollY.current) >= 6) setHeaderHidden(current > lastScrollY.current);
      lastScrollY.current = current;
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(updateFromScroll);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      if (event.clientY <= 18) setHeaderHidden(false);
      else if (event.clientY > 112 && window.scrollY > 96) setHeaderHidden(true);
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest(".site-header")) setHeaderHidden(false);
    };
    lastScrollY.current = window.scrollY;
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [drawerOpen, path]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setDrawerOpen(false); avatarButton.current?.focus(); } };
    const onOutside = (event: PointerEvent) => { if (event.target instanceof Node && !drawer.current?.contains(event.target) && !avatarButton.current?.contains(event.target)) setDrawerOpen(false); };
    document.addEventListener("keydown", onKey); document.addEventListener("pointerdown", onOutside);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onOutside); };
  }, [drawerOpen]);
  useEffect(() => () => { clearTimeout(hoverTimer.current); }, []);
  function hoverOpen(event: React.PointerEvent) { if (event.pointerType !== "mouse") return; clearTimeout(hoverTimer.current); if (!drawerOpen) openedByHover.current = true; setDrawerOpen(true); }
  function hoverClose() { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setDrawerOpen(false), 240); }

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    sessionTheme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    try { window.localStorage.setItem("zaoshi-theme", nextTheme); } catch { /* Storage may be blocked; the current session theme still works. */ }
    window.dispatchEvent(new Event(themeEvent));
  }

  return (
    <>
      <AnalyticsTracker path={path} />
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="header-reveal-zone" aria-hidden="true" onPointerEnter={() => setHeaderHidden(false)} />
      <header ref={header} className={`site-header${headerHidden ? " is-hidden" : ""}`} onPointerEnter={() => setHeaderHidden(false)}>
        <div className="header-inner">
          <a className="site-brand" href="/" aria-label="造室首页">
            <span className="brand-logo-mark" aria-hidden="true" />
            <span className="brand-word">造室</span>
          </a>
          <nav className="primary-nav" aria-label="主要导航">
            {navItems.map((item) => (
              <a key={item.href} href={item.href} aria-current={isActive(item.href, path) ? "page" : undefined}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <div className="header-account-slot">{account?.user.authenticated ? <a className="header-balance" href="/products#recharge" aria-label="积分余额与充值">{account.credits ? `${account.credits.available} 积分` : "余额暂不可用"}</a> : <><a className="header-auth-link" href="/login">登录</a><a className="header-auth-link" href="/login?mode=register">注册</a></>}</div>
            <button ref={avatarButton} className="account-avatar-button" type="button" aria-label="打开个人资料" aria-haspopup="dialog" aria-expanded={drawerOpen} aria-controls="account-popover" onPointerEnter={hoverOpen} onPointerLeave={hoverClose} onClick={() => { clearTimeout(hoverTimer.current); setHeaderHidden(false); if (openedByHover.current) setDrawerOpen(true); else setDrawerOpen(open => !open); openedByHover.current = false; }} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setDrawerOpen(true); requestAnimationFrame(() => closeButton.current?.focus()); } }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="7.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>
            </button>
          </div>
        </div>
      </header>
      <main id="main-content" className="site-main">{children}</main>

      {drawerOpen && (
        <div className="account-popover-layer">
          <aside id="account-popover" ref={drawer} className="account-popover account-drawer" role="dialog" aria-label="个人资料" data-ui onPointerEnter={hoverOpen} onPointerLeave={hoverClose}>
            <button ref={closeButton} className="icon-close account-menu-close" type="button" aria-label="关闭个人资料" onClick={() => { setDrawerOpen(false); avatarButton.current?.focus(); }}>×</button>
            <ProfileView compact appearance={<div className="account-menu-appearance"><span>外观</span><div role="group" aria-label="选择外观"><button type="button" aria-pressed={theme === "light"} onClick={() => { if (theme !== "light") toggleTheme(); }}>浅色</button><button type="button" aria-pressed={theme === "dark"} onClick={() => { if (theme !== "dark") toggleTheme(); }}>深色</button></div></div>} />
          </aside>
        </div>
      )}
    </>
  );
}
