"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { Entry, PermissionMode, RunState, ServerEvent, StreamDelta, TerminalInfo, ToolResult } from "@/lib/types";
import { api } from "./api";

type Stream = { msgId: string; index: number; kind: StreamDelta["kind"]; text: string };
/** A message the user sent that isn't in the transcript yet. Kept in sessionStorage so it survives remounts. */
export type Pending = {
  localId: string;
  text: string;
  at: number;
  state: "sending" | "sent" | "failed";
  via?: "terminal" | "web";
  error?: string;
};

/* the terminal path flattens newlines, and Claude Code trims; compare on collapsed whitespace */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const pendingKey = (id: string) => `pending:${id}`;

export type SessionView = {
  status: "connecting" | "open" | "reconnecting" | "missing";
  entries: Entry[];
  ids: Set<string>;
  results: Record<string, ToolResult>;
  cursor: number | null;
  loadingOlder: boolean;
  terminal: TerminalInfo | null;
  run: RunState | null;
  title: string;
  cwd: string;
  permissionMode: PermissionMode | null;
  streams: Stream[];
  pending: Pending[];
};

type Action =
  | { type: "event"; event: ServerEvent }
  | { type: "older"; entries: Entry[]; cursor: number | null }
  | { type: "loadingOlder" }
  | { type: "olderFailed" }
  | { type: "status"; status: SessionView["status"] }
  | { type: "pending"; pending: Pending }
  | { type: "updatePending"; localId: string; patch: Partial<Pending> }
  | { type: "restorePending"; pending: Pending[] }
  | { type: "dropPending"; localId: string };

const initial = (): SessionView => ({
  status: "connecting",
  entries: [],
  ids: new Set(),
  results: {},
  cursor: null,
  loadingOlder: false,
  terminal: null,
  run: null,
  title: "",
  cwd: "",
  permissionMode: null,
  streams: [],
  pending: [],
});

/* Folds a batch into the view: tool results attach by id, everything else is
 * de-duplicated by entry id (reconnects and overlapping reads both resend). */
function merge(state: SessionView, batch: Entry[], where: "append" | "prepend"): SessionView {
  const ids = new Set(state.ids);
  let results = state.results;
  let streams = state.streams;
  let pending = state.pending;
  const fresh: Entry[] = [];
  for (const e of batch) {
    if (e.kind === "result") {
      if (results === state.results) results = { ...results };
      results[e.toolUseId] = e.result;
      continue;
    }
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    fresh.push(e);
    if (e.kind === "text" || e.kind === "thinking") {
      /* the persisted block replaces the oldest live stream of the same kind for that message */
      const i = streams.findIndex((s) => s.msgId === e.msgId && s.kind === e.kind);
      if (i !== -1) streams = streams.filter((_, j) => j !== i);
    }
    if (e.kind === "user" && pending.length) {
      const i = pending.findIndex((p) => norm(p.text) === norm(e.text));
      if (i !== -1) pending = pending.filter((_, j) => j !== i);
    }
  }
  if (!fresh.length && results === state.results) return state;
  return {
    ...state,
    ids,
    results,
    streams,
    pending,
    entries: where === "append" ? [...state.entries, ...fresh] : [...fresh, ...state.entries],
  };
}

function reducer(state: SessionView, action: Action): SessionView {
  switch (action.type) {
    case "event": {
      const e = action.event;
      if (e.type === "history") {
        const first = state.status === "connecting";
        const merged = merge(first ? { ...state, entries: [], ids: new Set(), results: {} } : state, e.entries, "append");
        return {
          ...merged,
          status: "open",
          cursor: first ? e.cursor : state.cursor,
          terminal: e.terminal,
          run: e.run,
          title: e.title,
          cwd: e.cwd,
          permissionMode: e.permissionMode,
        };
      }
      if (e.type === "entries") return merge(state, e.entries, "append");
      if (e.type === "terminal") return { ...state, terminal: e.terminal };
      if (e.type === "run") {
        const ended = !e.run || e.run.status === "idle" || e.run.status === "closed" || e.run.status === "error";
        return { ...state, run: e.run, streams: ended ? [] : state.streams };
      }
      if (e.type === "delta") {
        const d = e.delta;
        const i = state.streams.findIndex((s) => s.msgId === d.msgId && s.index === d.index);
        const streams = i === -1 ? [...state.streams, { ...d }] : state.streams.map((s, j) => (j === i ? { ...s, text: s.text + d.text } : s));
        return { ...state, streams };
      }
      return state;
    }
    case "older":
      return { ...merge(state, action.entries, "prepend"), cursor: action.cursor, loadingOlder: false };
    case "loadingOlder":
      return { ...state, loadingOlder: true };
    case "olderFailed":
      return { ...state, loadingOlder: false };
    case "status":
      return { ...state, status: action.status };
    case "pending":
      return { ...state, pending: [...state.pending, action.pending] };
    case "updatePending":
      return { ...state, pending: state.pending.map((p) => (p.localId === action.localId ? { ...p, ...action.patch } : p)) };
    case "restorePending": {
      const have = new Set(state.pending.map((p) => p.localId));
      const seen = new Set(state.entries.flatMap((e) => (e.kind === "user" ? [norm(e.text)] : [])));
      return { ...state, pending: [...state.pending, ...action.pending.filter((p) => !have.has(p.localId) && !seen.has(norm(p.text)))] };
    }
    case "dropPending":
      return { ...state, pending: state.pending.filter((p) => p.localId !== action.localId) };
  }
}

export function useSession(id: string | null, onRedirect: (id: string) => void) {
  const [view, dispatch] = useReducer(reducer, undefined, initial);
  const redirectRef = useRef(onRedirect);
  redirectRef.current = onRedirect;

  useEffect(() => {
    if (!id) return;
    dispatch({ type: "status", status: "connecting" });
    const abort = new AbortController();
    /* history over a plain fetch, then a live stream from where it ended. The stream is a POST
     * read with fetch (not EventSource): some tunnels buffer GET event streams until they close. */
    (async () => {
      let from: number;
      try {
        const first = await api<Extract<ServerEvent, { type: "history" }> & { end: number }>(`/api/sessions/${id}`);
        if (abort.signal.aborted) return;
        dispatch({ type: "event", event: first });
        from = first.end;
      } catch {
        if (!abort.signal.aborted) dispatch({ type: "status", status: "missing" });
        return;
      }
      for (let attempt = 0; !abort.signal.aborted; attempt++) {
        try {
          const res = await fetch(`/api/sessions/${id}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from }),
            signal: abort.signal,
            cache: "no-store",
          });
          if (res.status === 401) {
            window.location.href = "/login";
            return;
          }
          if (res.status === 404) {
            dispatch({ type: "status", status: "missing" });
            return;
          }
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          for (;;) {
            /* the server pings every 15s; silence well past that means a dead connection the browser didn't notice */
            let stall: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<never>((_, reject) => {
              stall = setTimeout(() => reject(new Error("stalled")), 40_000);
            });
            const { value, done } = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(stall)).catch((err) => {
              void reader.cancel().catch(() => undefined);
              throw err;
            });
            if (done) break;
            buf += value;
            let cut;
            while ((cut = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, cut);
              buf = buf.slice(cut + 2);
              let data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("id: ")) from = Number(line.slice(4)) || from;
                else if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (!data) continue;
              attempt = 0;
              const event = JSON.parse(data) as ServerEvent;
              if (event.type === "redirect") {
                /* carry unsent bubbles over to the new id */
                const saved = sessionStorage.getItem(pendingKey(id));
                if (saved) sessionStorage.setItem(pendingKey(event.sessionId), saved);
                redirectRef.current(event.sessionId);
              }
              else if (event.type !== "ping") dispatch({ type: "event", event });
            }
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        dispatch({ type: "status", status: "reconnecting" });
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
      }
    })();
    return () => abort.abort();
  }, [id]);

  const cursorRef = useRef(view.cursor);
  cursorRef.current = view.cursor;
  const loadingRef = useRef(false);

  const loadOlder = useCallback(async () => {
    if (!id || cursorRef.current === null || loadingRef.current) return;
    loadingRef.current = true;
    dispatch({ type: "loadingOlder" });
    try {
      const page = await api<{ entries: Entry[]; cursor: number | null }>(`/api/sessions/${id}?before=${cursorRef.current}`);
      dispatch({ type: "older", entries: page.entries, cursor: page.cursor });
    } catch {
      dispatch({ type: "olderFailed" });
    } finally {
      loadingRef.current = false;
    }
  }, [id]);

  /* unsent messages survive reloads and remounts; restored once history has loaded, so ones that landed are skipped */
  const restored = useRef(false);
  useEffect(() => {
    if (!id || restored.current || view.status === "connecting") return;
    restored.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey(id)) ?? "[]") as Pending[];
      if (saved.length) dispatch({ type: "restorePending", pending: saved.map((p) => (p.state === "sending" ? { ...p, state: "sent" } : p)) });
    } catch {
      /* corrupt entry: ignore */
    }
  }, [id, view.status]);
  useEffect(() => {
    if (!id || !restored.current) return;
    if (view.pending.length) sessionStorage.setItem(pendingKey(id), JSON.stringify(view.pending));
    else sessionStorage.removeItem(pendingKey(id));
  }, [id, view.pending]);

  const addPending = useCallback((text: string) => {
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    dispatch({ type: "pending", pending: { localId, text, at: Date.now(), state: "sending" } });
    return localId;
  }, []);

  const updatePending = useCallback((localId: string, patch: Partial<Pending>) => dispatch({ type: "updatePending", localId, patch }), []);
  const dropPending = useCallback((localId: string) => dispatch({ type: "dropPending", localId }), []);

  return { view, loadOlder, addPending, updatePending, dropPending };
}
