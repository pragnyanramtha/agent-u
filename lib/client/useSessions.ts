"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary } from "@/lib/types";
import { api } from "./api";

type Listing = { sessions: SessionSummary[]; projects: string[] };

/** Session list, refreshed every few seconds while the tab is visible. */
export function useSessions(intervalMs = 5000) {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);
  const fails = useRef(0);
  const loaded = useRef(false);
  const last = useRef("");

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const next = await api<Listing>("/api/sessions");
      /* the poll mostly returns what's on screen; same text, same object, no re-render of the list */
      const text = JSON.stringify(next);
      if (text !== last.current) {
        last.current = text;
        setData(next);
      }
      setError(null);
      fails.current = 0;
      loaded.current = true;
    } catch (err) {
      /* a list on screen outlives short drops; the offline banner covers no network at all */
      fails.current += 1;
      if (navigator.onLine && (fails.current >= 3 || !loaded.current)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    let timer = setInterval(refresh, intervalMs);
    const onVisibility = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        void refresh();
        timer = setInterval(refresh, intervalMs);
      }
    };
    const onOnline = () => void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh, intervalMs]);

  return { sessions: data?.sessions ?? null, projects: data?.projects ?? [], error, refresh };
}
