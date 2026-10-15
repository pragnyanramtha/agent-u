"use client";

import { useEffect, useRef, useState } from "react";
import { terminalBusy } from "@/lib/status";
import type { SessionSummary } from "@/lib/types";
import { load, save } from "./storage";

/* Sessions that finished a turn while you weren't looking at them, until you open them (or dismiss them). */

const KEY = "inbox:finished";
const MAX = 40;

export type Finished = Record<string, number>;

const busyOf = (s: SessionSummary) => (s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status));

export function nextFinished(prev: Finished, wasBusy: Map<string, boolean>, sessions: SessionSummary[], activeId: string | null, now: number): Finished {
  let next = prev;
  const put = (id: string, v: number | null) => {
    if (next === prev) next = { ...prev };
    if (v === null) delete next[id];
    else next[id] = v;
  };
  for (const s of sessions) {
    const busy = busyOf(s);
    const before = wasBusy.get(s.id);
    wasBusy.set(s.id, busy);
    if (s.id === activeId) {
      if (next[s.id]) put(s.id, null);
      continue;
    }
    if (before === true && !busy && !s.web?.pending.length) put(s.id, now);
    else if (busy && next[s.id]) put(s.id, null);
  }
  const ids = Object.keys(next);
  if (ids.length > MAX) {
    next = Object.fromEntries(Object.entries(next).sort((a, b) => b[1] - a[1]).slice(0, MAX));
  }
  return next;
}

export function useFinished(sessions: SessionSummary[] | null, activeId: string | null) {
  const [finished, setFinished] = useState<Finished>({});
  const wasBusy = useRef(new Map<string, boolean>());
  useEffect(() => {
    try {
      setFinished(JSON.parse(load(KEY) ?? "{}") as Finished);
    } catch {}
  }, []);
  useEffect(() => {
    if (!sessions) return;
    setFinished((prev) => {
      const next = nextFinished(prev, wasBusy.current, sessions, activeId, Date.now());
      if (next !== prev) save(KEY, JSON.stringify(next));
      return next;
    });
  }, [sessions, activeId]);
  const dismiss = (id: string | null) =>
    setFinished((prev) => {
      const next = id ? { ...prev } : {};
      if (id) delete next[id];
      save(KEY, JSON.stringify(next));
      return next;
    });
  return { finished, dismiss };
}
