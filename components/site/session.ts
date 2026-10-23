"use client";
import { useEffect, useSyncExternalStore } from "react";
export type ClientSession = {
 user: { authenticated: boolean; displayName: string; email?: string };
 authMode: string; privateTest?: boolean; draftScope: string; isSiteAdmin?: boolean;
 credits?: { available: number; reserved: number; spent: number };
 legal?: { version: string; accepted: boolean };
 stats: { total: number; today: number; byKind: Record<string, number> };
};
let value: ClientSession | undefined;
let pending: Promise<ClientSession> | undefined;
let sessionError: string | undefined;
let epoch = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function getClientSession(): ClientSession | undefined { return value; }
export function loadSession(force = false, options: { preserveOnTransientFailure?: boolean } = {}): Promise<ClientSession> {
 if (pending && !force) return pending;
 if (value && !force && !sessionError) return Promise.resolve(value);
 const requestEpoch = ++epoch, previous = value;
 const preserve = force && options.preserveOnTransientFailure === true;let transientFailure = false;
 if (!preserve) value = undefined; sessionError = undefined;
 for (const listener of listeners) listener();
 pending = fetch("/api/me", { cache: "no-store", headers: { Accept: "application/json" } }).catch(error => { transientFailure = true; throw error; }).then(async response => {
  transientFailure = response.status === 429 || response.status >= 500;
  if (!response.ok) throw new Error("无法确认当前登录状态，请稍后重试。");
  const next = await response.json() as ClientSession;
  if (typeof next.user?.authenticated !== "boolean" || typeof next.draftScope !== "string") throw new Error("账户信息无法识别。");
  if (requestEpoch !== epoch) throw new Error("账户状态已更新，请重试。");
  sessionError = undefined; value = next; for (const listener of listeners) listener(); return next;
 }).catch(error => {
  if (requestEpoch === epoch) { value = preserve && transientFailure ? previous : undefined; sessionError = error instanceof Error ? error.message : "账户暂不可用。"; for (const listener of listeners) listener(); }
  throw error;
 }).finally(() => { if (requestEpoch === epoch) pending = undefined; });
 return pending;
}
export function useSessionError(): string | undefined { return useSyncExternalStore(subscribe, () => sessionError, () => undefined); }
export function useSession(): ClientSession | undefined {
 const snapshot = useSyncExternalStore(subscribe, getClientSession, () => undefined);
 useEffect(() => { void loadSession().catch(() => undefined); }, []);
 return snapshot;
}
export function returnPath(): string { return window.location.pathname + window.location.search; }
export function requireClientAccess(): boolean {
 const current = getClientSession();
 // A retained refresh snapshot is for display, not authorization of new actions.
 if (!current || pending || sessionError) return false;
 if (!current.user.authenticated) { window.location.assign(`/login?returnTo=${encodeURIComponent(returnPath())}`); return false; }
 if (!current.privateTest && !current.legal?.accepted) { window.location.assign(`/consent?returnTo=${encodeURIComponent(returnPath())}`); return false; }
 return true;
}
export async function requireAssetAccess(): Promise<void> {
 await loadSession();
 if (!requireClientAccess()) throw new Error("请先登录并确认用户协议。");
}
