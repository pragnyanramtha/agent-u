"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitCompare, Menu, MoreHoriz, Terminal } from "iconoir-react";
import { AGENT_LABEL, type AgentId, type PermissionMode } from "@/lib/types";
import { AgentBadge } from "./SessionList";
import { api, ApiError, shortPath } from "@/lib/client/api";
import { useSession } from "@/lib/client/useSession";
import { terminalBusy } from "@/lib/status";
import { AskCards } from "./AskCards";
import { Composer, MODELS } from "./Composer";
import { MODE_ALIASES } from "@/lib/commands";
import { ChangesPanel, collectChanges } from "./ChangesPanel";
import { OPEN_USAGE_EVENT } from "./ContextRing";
import { UsagePanel } from "./UsagePanel";
import { sessionCost } from "@/lib/client/usage";
import { PendingBubble } from "./PendingBubble";
import { TerminalPeek } from "./TerminalPeek";
import { Pulse } from "./Pulse";
import { Thread } from "./Thread";

function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(140);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
}

export function SessionScreen({ id, onMenu, onNavigate, onNew }: { id: string; onMenu: () => void; onNavigate: (id: string) => void; onNew: () => void }) {
  const { view, loadOlder, addPending, updatePending, dropPending } = useSession(id, onNavigate);
  const [localMode, setLocalMode] = useState<PermissionMode | null>(null);
  const [localModel, setLocalModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  useEffect(() => {
    const open = () => {
      setChangesOpen(false);
      setUsageOpen(true);
    };
    window.addEventListener(OPEN_USAGE_EVENT, open);
    return () => window.removeEventListener(OPEN_USAGE_EVENT, open);
  }, []);
  const [composerRef, composerH] = useMeasure<HTMLDivElement>();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const run = view.run && view.run.status !== "closed" ? view.run : null;
  const terminal = view.terminal;
  const busy = run ? run.status === "running" || run.status === "starting" : terminalBusy(terminal?.status);
  const mode = run?.permissionMode ?? localMode ?? view.permissionMode ?? "default";
  const model = localModel ?? run?.model ?? null;
  const where = terminal ? terminal.multiplexer ?? "a terminal" : null;
  const agent: AgentId = id.includes(":") ? (id.slice(0, id.indexOf(":")) as AgentId) : "claude";
  const agentName = AGENT_LABEL[agent];
  const changes = useMemo(() => collectChanges(view.entries, view.results), [view.entries, view.results]);
  const cost = useMemo(() => sessionCost(view.entries, view.run), [view.entries, view.run]);
  const usage = useMemo(() => {
    for (let i = view.entries.length - 1; i >= 0; i--) {
      const e = view.entries[i];
      if (e.kind === "usage") return e;
    }
    return null;
  }, [view.entries]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const inside = (t: EventTarget | null) => t instanceof Element && Boolean(t.closest("[data-session-menu]"));
    const close = (e: PointerEvent) => !inside(e.target) && setMenuOpen(false);
    const onFocus = (e: FocusEvent) => !inside(e.target) && setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    if (run?.error) setError(run.error);
  }, [run?.error]);

  useEffect(() => {
    document.title = view.title ? `${view.title} · Claude` : "Claude";
  }, [view.title]);

  /* the bubble stays until the message shows up in the transcript; failures stay visible with Retry */
  const deliver = useCallback(
    async (localId: string, text: string) => {
      updatePending(localId, { state: "sending", error: undefined, at: Date.now() });
      try {
        const res = await api<{ id: string; via?: "terminal" | "web"; cleared?: string | null }>(`/api/sessions/${id}/message`, {
          text,
          model: localModel ?? undefined,
          permissionMode: localMode ?? undefined,
        });
        updatePending(localId, { state: "sent", via: res.via, at: Date.now() });
        /* a greyed suggestion or half-typed text was in the terminal's prompt; say what was cleared */
        if (res.cleared && !/^Try "/.test(res.cleared)) setError(`Cleared "${res.cleared.slice(0, 80)}" from the terminal's prompt before sending.`);
        if (res.id !== id) onNavigate(res.id);
      } catch (err) {
        updatePending(localId, { state: "failed", error: err instanceof ApiError ? err.message : "Couldn't reach the server." });
        /* the terminal refused the keystrokes: show it, so the reason is visible */
        if (err instanceof ApiError && ["agent_focus", "has_text", "no_prompt"].includes(err.code ?? "")) setPeek(true);
      }
    },
    [id, localModel, localMode, updatePending, onNavigate],
  );
  const send = useCallback(
    async (text: string) => {
      void deliver(addPending(text), text);
      return true;
    },
    [deliver, addPending],
  );

  const control = useCallback(
    async (action: string, value?: string) => {
      try {
        await api(`/api/sessions/${id}/control`, { action, value });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id],
  );

  /* Esc interrupts a terminal Claude, like pressing it at the keyboard */
  const pressKey = useCallback(
    async (key: string) => {
      try {
        await api(`/api/sessions/${id}/keys`, { key });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [id],
  );

  const respond = useCallback(
    async (body: { requestId: string; allow: boolean; always?: boolean; answers?: Record<string, string> }) => {
      try {
        await api(`/api/sessions/${id}/respond`, body);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [id],
  );

  /* Below 380px the pill drops its label (kept for screen readers) so the title keeps its room. */
  const pill = "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium max-[379px]:w-7 max-[379px]:justify-center max-[379px]:px-0";
  const pillLabel = "max-w-[9rem] truncate max-[379px]:sr-only";
  const runLabel = run ? (run.pending.length ? "Needs you" : busy ? "Working…" : "Ready") : "";
  const status = view.status === "reconnecting" ? (
    <span role="status" className={`${pill} bg-orange-tint text-orange-ink`} title="Reconnecting…">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-current" aria-hidden />
      <span className={pillLabel}>Reconnecting…</span>
    </span>
  ) : terminal ? (
    <span className={`${pill} bg-hover text-ink-2`} title={`Open in ${where}`}>
      <Pulse busy={terminalBusy(terminal.status)} />
      <span className={pillLabel}>
        <span className="sr-only">Open in </span>
        {where}
      </span>
    </span>
  ) : run ? (
    <span role="status" className={`${pill} ${run.pending.length ? "bg-orange-tint text-orange-ink" : "bg-hover text-ink-2"}`} title={runLabel}>
      <Pulse busy={busy} cellClass={run.pending.length ? "bg-current" : "bg-ink"} />
      <span className={pillLabel}>{runLabel}</span>
    </span>
  ) : null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="safe-top safe-x flex shrink-0 items-center border-b border-line">
        <div className="flex h-14 w-full min-w-0 items-center gap-1 px-1.5 sm:gap-2 sm:px-4">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-ink-2 hover:bg-hover hover:text-ink lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <div className="min-w-0 flex-1 px-1">
            <h1 className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-ink" title={view.title || undefined}>
              {view.title || (view.status === "missing" ? "Couldn’t load this session" : "Loading session…")}
            </h1>
            <p className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ink-3">
              {agent !== "claude" && <AgentBadge agent={agent} />}
              <span className="truncate font-mono" translate="no">
                {shortPath(view.cwd)}
              </span>
            </p>
          </div>
          {status}
          {changes.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setUsageOpen(false);
                setChangesOpen((v) => !v);
              }}
              aria-pressed={changesOpen}
              aria-label={`Changes: ${changes.length} ${changes.length === 1 ? "file" : "files"}`}
              title="Changes"
              className={`flex h-10 shrink-0 items-center gap-1 rounded-[10px] px-2 text-[12px] font-medium tabular-nums hover:bg-hover hover:text-ink ${changesOpen ? "bg-hover text-ink" : "text-ink-2"}`}
            >
              <GitCompare width={17} height={17} strokeWidth={1.8} />
              <span className="max-[379px]:sr-only">{changes.length}</span>
            </button>
          )}
          {terminal && !run && (
            <button
              type="button"
              onClick={() => setPeek((v) => !v)}
              aria-pressed={peek}
              aria-label={peek ? "Hide terminal" : "Show terminal"}
              title={peek ? "Hide terminal" : "Show terminal"}
              className={`flex size-10 shrink-0 items-center justify-center rounded-[10px] hover:bg-hover hover:text-ink ${peek ? "bg-hover text-ink" : "text-ink-2"}`}
            >
              <Terminal width={17} height={17} strokeWidth={1.8} />
            </button>
          )}
          {run && (
            <div className="relative shrink-0" data-session-menu>
              <button
                ref={menuButtonRef}
                type="button"
                aria-label="Session options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" && !menuOpen) {
                    e.preventDefault();
                    setMenuOpen(true);
                  }
                }}
                className={`flex size-10 items-center justify-center rounded-[10px] hover:bg-hover hover:text-ink ${menuOpen ? "bg-hover text-ink" : "text-ink-2"}`}
              >
                <MoreHoriz width={18} height={18} strokeWidth={1.8} />
              </button>
              {menuOpen && (
                <div ref={menuRef} role="menu" aria-label="Session options" className="absolute top-full right-0 z-30 mt-1 w-60 max-w-[calc(100vw-1rem)] rounded-[12px] bg-surface p-1 shadow-overlay" style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      menuButtonRef.current?.focus();
                      void control("stop");
                    }}
                    className="flex w-full flex-col items-start rounded-[8px] px-2.5 py-2 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]"
                  >
                    <span className="text-[13px] font-medium text-ink">End web session</span>
                    <span className="text-[12px] text-ink-3">Stops the claude process. History stays.</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>
      {peek && terminal && !run && <TerminalPeek id={id} pid={terminal.pid} where={where ?? "terminal"} onClose={() => setPeek(false)} />}

      <Thread
        view={view}
        busy={Boolean(busy)}
        workingLabel={terminal && !run ? `Working in ${where}` : agent === "claude" ? "Thinking" : `${agentName} is working`}
        onLoadOlder={() => void loadOlder()}
        pendingSlot={(p) => (
          <PendingBubble
            pending={p}
            where={where}
            claudeBusy={Boolean(busy)}
            onRetry={() => void deliver(p.localId, p.text)}
            onDiscard={() => dropPending(p.localId)}
          />
        )}
        bottomPad={composerH}
        footer={run?.pending.length ? <AskCards pending={run.pending} respond={respond} /> : null}
        empty={
          view.status === "missing" ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-[13px] text-ink-3">The server didn&apos;t return this session. Check your connection, then reload.</p>
              <button type="button" onClick={() => window.location.reload()} className="h-9 rounded-full px-3.5 text-[12.5px] font-medium text-ink shadow-btn hover:bg-hover">
                Reload
              </button>
            </div>
          ) : (
            <p className="py-16 text-center text-[13px] text-ink-3">{terminal && !run ? `Nothing recorded yet. Type below and it goes into ${where}.` : "No messages yet. Send one to start."}</p>
          )
        }
      />

      <div ref={composerRef} className="safe-bottom safe-x pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="h-6 bg-gradient-to-t from-page to-transparent" />
        <div className="pointer-events-auto bg-page px-3 pb-3 sm:px-8 sm:pb-5">
          <div className="mx-auto max-w-[740px]">
            {error && (
              <p role="alert" className="mb-2 rounded-[10px] bg-red-tint px-3 py-2 text-[13px] text-red-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                {error}
              </p>
            )}
            <Composer
              draftKey={id}
              placeholder={terminal && !run ? `Type into ${where}…` : `Reply to ${agentName}…`}
              onSend={send}
              running={Boolean(busy && (run || terminal))}
              onStop={() => (run ? void control("interrupt") : void pressKey("Escape"))}
              slashCommands={run?.slashCommands ?? []}
              mode={mode}
              onModeChange={(m) => (run ? void control("mode", m) : setLocalMode(m))}
              model={model}
              onModelChange={(m) => {
                setLocalModel(m || null);
                if (run) void control("model", m);
              }}
              autoFocus
              cwd={agent === "claude" ? view.cwd || undefined : undefined}
              models={agent === "claude" ? undefined : [{ key: "", name: "Default" }]}
              usage={usage}
              suggestion={run?.suggestion ?? null}
              cost={cost}
              costUsd={run?.costUsd ?? null}
              onAppCommand={(name, arg) => {
                const a = arg.toLowerCase();
                if (name === "model") {
                  const m = MODELS.find((x) => x.key === a || x.name.toLowerCase().startsWith(a))?.key ?? (a === "default" ? "" : null);
                  if (m === null) return setError("Use /model opus, sonnet, haiku, or default."), true;
                  setLocalModel(m || null);
                  if (run) void control("model", m);
                } else if (name === "mode") {
                  const m = MODE_ALIASES[a.replace(/\s+/g, "")];
                  if (!m) return setError("Use /mode ask, edits, plan, or bypass."), true;
                  if (run) void control("mode", m);
                  else setLocalMode(m);
                } else if (name === "stop") {
                  if (run) void control("interrupt");
                  else if (terminal) void pressKey("Escape");
                } else if (name === "new") onNew();
                else if (name === "end") {
                  if (run) void control("stop");
                } else return false;
                return true;
              }}
            />
          </div>
        </div>
      </div>
    </section>
    {usageOpen && <UsagePanel view={view} onClose={() => setUsageOpen(false)} />}
    {changesOpen && <ChangesPanel changes={changes} cwd={view.cwd} partial={view.cursor !== null} onClose={() => setChangesOpen(false)} />}
    </div>
  );
}
