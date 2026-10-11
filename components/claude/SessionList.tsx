"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, EditPencil, FilterList, LogOut, NavArrowDown, Search, Xmark } from "iconoir-react";
import GlideMenu from "@/components/primitives/GlideMenu";
import { AGENT_LABEL, type AgentId, type SessionSummary } from "@/lib/types";
import { api, timeAgo } from "@/lib/client/api";
import { terminalBusy } from "@/lib/status";
import { OPEN_PALETTE_EVENT } from "./CommandPalette";
import { Pulse } from "./Pulse";
import { ThemeToggle } from "./ThemeToggle";

export const isBusy = (s: Pick<SessionSummary, "terminal" | "web">) =>
  s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status);

const isLive = (s: SessionSummary) => Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");

function Row({ s, active, open, onPick, now }: { s: SessionSummary; active: boolean; open: boolean; onPick: (id: string) => void; now: number }) {
  const live = isLive(s);
  const where = s.web ? "web" : s.terminal?.multiplexer ?? (s.terminal ? "terminal" : null);
  const waiting = (s.web?.pending.length ?? 0) > 0;
  return (
    <button
      type="button"
      data-menu-row
      onClick={() => onPick(s.id)}
      aria-current={active ? "page" : undefined}
      title={s.title}
      className={`relative z-10 flex w-full items-start gap-2 rounded-control px-2 py-2 text-left transition-[background-color,transform] duration-100 focus-visible:outline-offset-[-2px] active:scale-[0.99] sm:py-1.5 ${active ? "bg-hover-2" : ""}`}
    >
      {live && (
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          <Pulse busy={isBusy(s)} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate text-[14px] font-medium sm:text-[13.5px] ${active || open ? "text-ink" : "text-ink-2"}`}>{s.title}</span>
          {s.agent !== "claude" && <AgentBadge agent={s.agent} />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3 sm:text-[11.5px]">
          <span className="truncate">{s.project || "No folder"}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{live && where ? where : timeAgo(s.mtime, now)}</span>
        </span>
      </span>
      {waiting && <span className="mt-0.5 shrink-0 whitespace-nowrap rounded-full bg-orange-tint px-1.5 py-0.5 text-[11px] font-medium text-orange-ink">Needs you</span>}
    </button>
  );
}

export function AgentBadge({ agent }: { agent: AgentId }) {
  return <span className="shrink-0 rounded-[5px] bg-inset px-1.5 py-px font-mono text-[10.5px] font-medium text-ink-3 shadow-hairline">{AGENT_LABEL[agent]}</span>;
}

type GroupBy = "time" | "project" | "agent";
const GROUP_LABEL: Record<GroupBy, string> = { time: "Date", project: "Project", agent: "Agent" };

function timeBucket(ms: number, now: number) {
  const day = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const d = Math.round((day(now) - day(ms)) / 86_400_000);
  return d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 7 ? "This week" : d < 31 ? "This month" : "Older";
}

/** Groups keep their newest-first order; groups are ordered by their newest session. */
function groupRows(rows: SessionSummary[], by: GroupBy, now: number) {
  const groups = new Map<string, SessionSummary[]>();
  for (const s of rows) {
    const key = by === "time" ? timeBucket(s.mtime, now) : by === "agent" ? AGENT_LABEL[s.agent] : s.project || "No folder";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()];
}

function useStored<T extends string>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    const saved = localStorage.getItem(key) as T | null;
    if (saved) setValue(saved);
  }, [key]);
  const set = (v: T) => {
    setValue(v);
    localStorage.setItem(key, v);
  };
  return [value, set] as const;
}

/** A harness rail row: icon, label, and a quiet keyboard hint. */
function RailButton({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-menu-row
      onClick={onClick}
      className="relative z-10 flex h-10 w-full items-center gap-2 rounded-control px-2 text-left text-ink-2 transition-[color,transform] duration-150 hover:text-ink active:scale-[0.98] focus-visible:outline-offset-[-2px] sm:h-8"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{label}</span>
      {hint && (
        <kbd className="hidden shrink-0 font-sans text-[11.5px] font-medium tracking-wide text-ink-3 pointer-fine:inline" aria-hidden>
          {hint}
        </kbd>
      )}
    </button>
  );
}

/** Group-by and agent filter, folded into one small menu beside the section label. */
function ViewMenu({
  groupBy,
  onGroupBy,
  agents,
  agent,
  onAgent,
}: {
  groupBy: GroupBy;
  onGroupBy: (g: GroupBy) => void;
  agents: AgentId[];
  agent: AgentId | "all";
  onAgent: (a: AgentId | "all") => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const inside = (t: EventTarget | null) => t instanceof Node && Boolean(ref.current?.parentElement?.contains(t));
    const close = (e: PointerEvent) => !inside(e.target) && setOpen(false);
    const onFocus = (e: FocusEvent) => !inside(e.target) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const item = (checked: boolean, label: string, onClick: () => void) => (
    <button
      key={label}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-menu-row
      onClick={() => {
        onClick();
        setOpen(false);
        buttonRef.current?.focus();
      }}
      className="relative z-10 flex h-9 w-full items-center gap-2 rounded-control px-2 text-left text-[13px] text-ink focus-visible:outline-offset-[-2px] sm:h-8"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check width={15} height={15} strokeWidth={2} className="shrink-0" aria-hidden />}
    </button>
  );
  const filtered = agent !== "all";
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label={`View: grouped by ${GROUP_LABEL[groupBy].toLowerCase()}${filtered ? `, ${AGENT_LABEL[agent]} only` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`tap relative flex h-8 items-center gap-1 rounded-control px-1.5 text-[12px] font-medium transition-colors duration-150 hover:bg-hover-2 hover:text-ink ${open ? "bg-hover-2 text-ink" : filtered ? "text-accent-ink" : "text-ink-3"}`}
      >
        <FilterList width={14} height={14} strokeWidth={2} aria-hidden />
        <span>{filtered ? AGENT_LABEL[agent] : GROUP_LABEL[groupBy]}</span>
      </button>
      {open && (
        <div
          ref={ref}
          role="menu"
          aria-label="View"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
          className="absolute top-full right-0 z-30 mt-1 w-48 rounded-[12px] bg-surface p-1 shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
        >
          <div className="px-2 pt-1.5 pb-1 text-[11.5px] font-medium text-ink-3">Group by</div>
          <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-control bg-hover">
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => item(groupBy === g, GROUP_LABEL[g], () => onGroupBy(g)))}
          </GlideMenu>
          {agents.length > 1 && (
            <>
              <div className="mx-1 my-1 h-px bg-line" />
              <div className="px-2 pt-1 pb-1 text-[11.5px] font-medium text-ink-3">Agent</div>
              <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-control bg-hover">
                {item(agent === "all", "All agents", () => onAgent("all"))}
                {agents.map((a) => item(agent === a, AGENT_LABEL[a], () => onAgent(a)))}
              </GlideMenu>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionList({
  sessions,
  activeId,
  openIds,
  onPick,
  onNew,
  error,
}: {
  sessions: SessionSummary[] | null;
  activeId: string | null;
  /** sessions open in a tab read a shade stronger */
  openIds?: { id: string }[];
  onPick: (id: string) => void;
  onNew: () => void;
  error: string | null;
}) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [groupBy, setGroupBy] = useStored<GroupBy>("cui:groupBy", "time");
  const [agentFilter, setAgentFilter] = useStored<AgentId | "all">("cui:agent", "all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const now = Date.now();
  const open = useMemo(() => new Set((openIds ?? []).map((t) => t.id)), [openIds]);
  const agentsPresent = useMemo(() => [...new Set((sessions ?? []).map((s) => s.agent))], [sessions]);
  const { live, recent } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = (sessions ?? []).filter(
      (s) => (agentFilter === "all" || s.agent === agentFilter) && (!q || `${s.title} ${s.cwd} ${AGENT_LABEL[s.agent]}`.toLowerCase().includes(q)),
    );
    return { live: rows.filter(isLive), recent: rows.filter((s) => !isLive(s)) };
  }, [sessions, query, agentFilter]);
  const groups = useMemo(() => groupRows(recent, groupBy, now), [recent, groupBy, now]);
  const toggle = (g: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  return (
    <nav aria-label="Sessions" className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 sm:h-11">
        <span className="flex size-6 items-center justify-center rounded-[7px] bg-ink">
          <Pulse busy={false} size={3} cellClass="bg-surface" />
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">agent-u</span>
      </div>

      <div className="px-2 pb-2">
        <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-control bg-hover-2">
          <RailButton icon={<EditPencil width={17} height={17} strokeWidth={1.8} />} label="New session" hint="Alt T" onClick={onNew} />
          <RailButton icon={<Search width={17} height={17} strokeWidth={1.8} />} label="Search" hint="Ctrl K" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))} />
        </GlideMenu>
      </div>

      {/* section header: label, view menu, and a filter that grows out of its icon (the harness's chat search) */}
      <div className="relative mx-2 mb-1 flex h-8 shrink-0 items-center">
        <div
          aria-hidden={searching}
          className={`flex min-w-0 flex-1 items-center gap-1 transition-[opacity,transform] duration-200 ${searching ? "pointer-events-none -translate-x-1 opacity-0" : ""}`}
          style={{ transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)" }}
        >
          <span className="px-2 text-[12.5px] font-medium text-ink-3">Sessions</span>
          <span className="ml-auto" />
          <ViewMenu groupBy={groupBy} onGroupBy={setGroupBy} agents={agentsPresent} agent={agentFilter} onAgent={setAgentFilter} />
          <button
            type="button"
            aria-label="Filter sessions"
            aria-expanded={searching}
            tabIndex={searching ? -1 : 0}
            onClick={() => setSearching(true)}
            className="tap relative flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
          >
            <Search width={15} height={15} strokeWidth={1.9} aria-hidden />
          </button>
        </div>
        <label
          className={`absolute top-0 right-0 z-20 flex h-8 items-center overflow-hidden rounded-control bg-field text-ink-3 shadow-hairline transition-[width,opacity] duration-200 focus-within:text-ink-2 ${searching ? "opacity-100" : "pointer-events-none opacity-0"}`}
          style={{ width: searching ? "100%" : 32, transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)" }}
          inert={!searching}
        >
          <Search width={14} height={14} strokeWidth={1.9} className="ml-2.5 shrink-0" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              /* Enter opens the top match; Escape clears and folds the field back */
              const first = live[0] ?? recent[0];
              if (e.key === "Enter" && query && first) onPick(first.id);
              if (e.key === "Escape") {
                e.stopPropagation();
                if (query) setQuery("");
                else setSearching(false);
              }
            }}
            onBlur={() => !query && setSearching(false)}
            type="search"
            enterKeyHint="go"
            placeholder="Filter sessions…"
            name="session-search"
            autoComplete="off"
            aria-label="Filter sessions"
            className="ml-1.5 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-[13px] sm:pointer-coarse:text-[16px] [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            aria-label="Close filter"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeSearch}
            className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-hover-2 hover:text-ink"
          >
            <Xmark width={14} height={14} strokeWidth={2} aria-hidden />
          </button>
        </label>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {error && (
          <p role="alert" className="mb-2 rounded-control bg-red-tint px-2.5 py-2 text-[12.5px] text-red-ink">
            Couldn&apos;t load sessions: {error}
          </p>
        )}
        {sessions === null && !error && (
          <div className="flex flex-col pt-1" role="status" aria-label="Loading sessions…">
            {[72, 58, 80, 64, 50, 68].map((w, i) => (
              <div key={i} className="flex flex-col gap-1.5 px-2 py-2.5 sm:py-2" style={{ animation: `fade-in 400ms ease ${i * 60}ms both` }}>
                <div className="h-3 rounded-full bg-hover-2" style={{ width: `${w}%` }} />
                <div className="h-2.5 rounded-full bg-hover" style={{ width: `${w * 0.55}%` }} />
              </div>
            ))}
          </div>
        )}
        {live.length > 0 && (
          <section className="mb-2">
            <h2 className="flex h-7 items-center px-2 text-[12px] font-medium text-ink-3">Open now</h2>
            <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-control bg-hover">
              {live.map((s) => (
                <Row key={s.id} s={s} active={s.id === activeId} open={open.has(s.id)} onPick={onPick} now={now} />
              ))}
            </GlideMenu>
          </section>
        )}
        {groups.map(([name, rows]) => {
          const shut = collapsed.has(name) && !query;
          return (
            <section key={name} className="mb-2">
              <h2>
                <button
                  type="button"
                  onClick={() => toggle(name)}
                  aria-expanded={!shut}
                  className="flex h-7 w-full items-center gap-1.5 rounded-control px-2 text-left text-[12px] font-medium text-ink-3 hover:text-ink-2"
                >
                  <NavArrowDown width={11} height={11} strokeWidth={2.4} className={`shrink-0 transition-transform duration-200 ${shut ? "-rotate-90" : ""}`} aria-hidden />
                  <span className="min-w-0 truncate">{name}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-ink-3/80">{rows.length}</span>
                </button>
              </h2>
              {!shut && (
                <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-control bg-hover">
                  {rows.map((s) => (
                    <Row key={s.id} s={s} active={s.id === activeId} open={open.has(s.id)} onPick={onPick} now={now} />
                  ))}
                </GlideMenu>
              )}
            </section>
          );
        })}
        {sessions !== null && !live.length && !recent.length && (
          <div className="flex flex-col items-start gap-2 px-2 py-3">
            <p className="text-[13px] text-ink-3">
              {query ? (
                <>
                  No sessions match <span className="font-medium text-ink-2">“{query.trim()}”</span>.
                </>
              ) : agentFilter !== "all" ? (
                `No ${AGENT_LABEL[agentFilter]} sessions yet.`
              ) : (
                "No sessions yet. Start one with New session."
              )}
            </p>
            {(query || agentFilter !== "all") && (
              <button
                type="button"
                onClick={() => (query ? setQuery("") : setAgentFilter("all"))}
                className="tap relative -ml-1 rounded-full px-1 text-[12.5px] font-medium text-accent-ink hover:underline"
              >
                {query ? "Clear filter" : "Show all agents"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mx-2 flex shrink-0 items-center justify-between border-t border-line pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] pl-1">
        <ThemeToggle />
        <button
          type="button"
          onClick={async () => {
            await api("/api/auth/logout", {}).catch(() => undefined);
            window.location.href = "/login";
          }}
          className="tap relative flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"
        >
          <LogOut width={14} height={14} strokeWidth={1.9} aria-hidden />
          Sign out
        </button>
      </div>
    </nav>
  );
}
