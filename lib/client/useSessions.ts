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

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setData(await api<Listing>("/api/sessions"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, intervalMs]);

  return { sessions: data?.sessions ?? null, projects: data?.projects ?? [], error, refresh };
}
