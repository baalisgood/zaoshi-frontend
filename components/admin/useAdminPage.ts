"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PageData = { items?: unknown[]; nextCursor?: string | null; [key: string]: unknown };
type Page = { data?: PageData; cursors: string[]; busy: boolean; error: string };

// Only successful requests commit a cursor; failures leave the displayed page intact.
export function useAdminPage(url: string) {
  const [page, setPage] = useState<Page>({ cursors: [""], busy: true, error: "" });
  const current = useRef(page); current.current = page;
  const source = useRef(url); source.current = url;
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const load = useCallback(async (cursors: string[]) => {
    const version = ++generation.current;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    locked.current = true;
    setPage(previous => ({ ...previous, busy: true, error: "" }));
    try {
      const params = new URL(url, window.location.origin);
      const cursor = cursors.at(-1);
      if (cursor) params.searchParams.set("cursor", cursor);
      const response = await fetch(params.pathname + params.search, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || body.message || "管理数据读取失败，请重试。");
      if (version !== generation.current || source.current !== url || controller.signal.aborted) return;
      setPage({ data: body, cursors, busy: false, error: "" });
    } catch (error) {
      if (version === generation.current && source.current === url && !controller.signal.aborted) {
        setPage(previous => ({ ...previous, busy: false, error: error instanceof Error ? error.message : "管理数据读取失败。" }));
      }
    } finally { if (version === generation.current) locked.current = false; }
  }, [url]);
  useEffect(() => {
    // Filters own their cursor history; never send a cursor from the previous query.
    current.current = { cursors: [""], busy: true, error: "" };
    void Promise.resolve().then(() => { setPage({ cursors: [""], busy: true, error: "" }); void load([""]); });
    return () => { generation.current += 1; active.current?.abort(); locked.current = false; };
  }, [load]);
  const navigate = (direction: "next" | "previous") => {
    if (locked.current) return;
    const value = current.current;
    if (direction === "next" && value.data?.nextCursor) void load([...value.cursors, value.data.nextCursor]);
    if (direction === "previous" && value.cursors.length > 1) void load(value.cursors.slice(0, -1));
  };
  // A successful mutation must invalidate even a read already in flight.
  const refresh = useCallback(() => { void load(current.current.cursors); }, [load]);
  return { ...page, pageNumber: page.cursors.length, refresh, next: () => navigate("next"), previous: () => navigate("previous") };
}
