"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, EditPencil, Folder, LogOut, MoreHoriz, NavArrowRight, Search, SidebarCollapse, SidebarExpand, Terminal, Xmark } from "iconoir-react";
import { AGENT_LABEL, type AgentId, type SessionSummary } from "@/lib/types";
import { api, shortPath, timeAgo } from "@/lib/client/api";
import { terminalBusy } from "@/lib/status";
import { OPEN_PALETTE_EVENT } from "./CommandPalette";
import { Pulse } from "./Pulse";
import { ThemeToggle } from "./ThemeToggle";

/* ─────────────────────────────────────────────────────────
 * SIDEBAR
 * A quiet, ChatGPT-like list: brand row with search and the
 * collapse toggle, "New session", then Open now, Projects and
 * Recents. Rows are one line; detail lives in the hover title.
 * Grouping and the agent filter sit in the Recents overflow.
 * Collapsed on desktop, SessionRail stands in for it.
 * ───────────────────────────────────────────────────────── */

export const isBusy = (s: Pick<SessionSummary, "terminal" | "web">) =>
  s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status);

export const isLive = (s: SessionSummary) => Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");

/** One color per agent, used for the tiny marks in tabs and the rail. Claude stays neutral. */
export const AGENT_TONE: Record<AgentId, string> = {
  claude: "bg-ink",
  codex: "bg-agent-codex",
  opencode: "bg-agent-opencode",
  cursor: "bg-agent-cursor",
  devin: "bg-agent-devin",
  kimi: "bg-agent-kimi",
};

/** A tiny colored dot that names the agent for screen readers and on hover. */
export function AgentMark({ agent, className = "" }: { agent: AgentId; className?: string }) {
  return <span role="img" aria-label={AGENT_LABEL[agent]} title={AGENT_LABEL[agent]} className={`inline-block size-1.5 shrink-0 rounded-full ${AGENT_TONE[agent]} ${className}`} />;
}

export function AgentBadge({ agent }: { agent: AgentId }) {
  return <span className="shrink-0 text-[12px] text-ink-3">{AGENT_LABEL[agent]}</span>;
}

const whereOf = (s: SessionSummary) => (s.web ? "web" : s.terminal?.multiplexer ?? (s.terminal ? "terminal" : null));
const ago = (ms: number, now: number) => {
  const t = timeAgo(ms, now);
  return t === "now" ? "just now" : /\d$/.test(t) ? `on ${t}` : `${t} ago`;
};

/** The hover title: the full name, the folder, and when (or where it's open). */
const rowTitle = (s: SessionSummary, now: number) => {
  const where = whereOf(s);
  return `${s.title}\n${s.project || "No folder"} · ${isLive(s) && where ? `open in ${where}` : ago(s.mtime, now)}${s.agent !== "claude" ? ` · ${AGENT_LABEL[s.agent]}` : ""}`;
};

/** Ctrl or ⌘, read after mount so the server render matches. */
export function useModKey() {
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);
  return mod;
}

function useStored<T extends string>(key: string, fallback: T, allowed?: readonly T[]) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      if (saved && (!allowed || allowed.includes(saved))) setValue(saved);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {}
  };
  return [value, set] as const;
}

/** Quiet square icon button with a hover tooltip. */
export function IconButton({
  label,
  tip,
  tipPos,
  onClick,
  children,
  className = "",
  pressed,
}: {
  label: string;
  tip?: string;
  tipPos?: "right" | "bottom" | "bottom-end";
  onClick: () => void;
  children: ReactNode;
  className?: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-tip={tip ?? label}
      data-tip-pos={tipPos ?? "bottom"}
      onClick={onClick}
      className={`icon-btn ${className}`}
    >
      {children}
    </button>
  );
}

function Brand() {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-ink">
      <Pulse busy={false} size={3} cellClass="bg-page" />
    </span>
  );
}

/* ── rows ───────────────────────────────────────────────── */

function Row({
  s,
  active,
  onPick,
  now,
  lead,
  indent,
  showAgent = true,
}: {
  s: SessionSummary;
  active: boolean;
  onPick: (id: string) => void;
  now: number;
  lead?: ReactNode;
  indent?: boolean;
  showAgent?: boolean;
}) {
  const waiting = (s.web?.pending.length ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={() => onPick(s.id)}
      aria-current={active ? "page" : undefined}
      title={rowTitle(s, now)}
      className={`side-row ${indent ? "pl-[34px]" : ""}`}
    >
      {lead}
      <span className="min-w-0 flex-1 truncate">{s.title}</span>
      {waiting ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-orange-ink">
          <span className="size-1.5 rounded-full bg-orange" aria-hidden />
          Needs you
        </span>
      ) : (
        showAgent && s.agent !== "claude" && <span className="shrink-0 text-[12px] text-ink-3">{AGENT_LABEL[s.agent]}</span>
      )}
    </button>
  );
}

const PulseSlot = ({ s }: { s: SessionSummary }) => (
  <span className="flex size-4 shrink-0 items-center justify-center">
    <Pulse busy={isBusy(s)} size={2.5} cellClass={AGENT_TONE[s.agent]} />
  </span>
);

/* ── sections ───────────────────────────────────────────── */

function Section({
  label,
  open,
  onToggle,
  action,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="group/section mt-5 first:mt-1">
      <div className="flex h-8 items-center gap-1 pr-1">
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="group/label flex h-8 w-full items-center gap-1 rounded-control px-2.5 text-left text-[13px] text-ink-3 transition-colors duration-150 hover:text-ink-2 focus-visible:outline-offset-[-2px]"
          >
            <span className="truncate">{label}</span>
            <NavArrowRight
              width={11}
              height={11}
              strokeWidth={2.2}
              aria-hidden
              className={`shrink-0 transition-[opacity,transform] duration-150 group-hover/section:opacity-100 group-focus-visible/label:opacity-100 pointer-coarse:opacity-100 ${open ? "rotate-90 opacity-0" : "opacity-100"}`}
            />
          </button>
        </h2>
        {action}
      </div>
      {open && <div className="flex flex-col gap-px">{children}</div>}
    </section>
  );
}

type RecentsGroup = "none" | "time" | "agent";
const GROUPS: readonly RecentsGroup[] = ["none", "time", "agent"];
const GROUP_LABEL: Record<RecentsGroup, string> = { none: "None", time: "Date", agent: "Agent" };

function timeBucket(ms: number, now: number) {
  const day = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const d = Math.round((day(now) - day(ms)) / 86_400_000);
  return d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 7 ? "This week" : d < 31 ? "This month" : "Older";
}

function groupRows(rows: SessionSummary[], by: RecentsGroup, now: number): [string, SessionSummary[]][] {
  if (by === "none") return [["", rows]];
  const groups = new Map<string, SessionSummary[]>();
  for (const s of rows) {
    const key = by === "time" ? timeBucket(s.mtime, now) : AGENT_LABEL[s.agent];
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()];
}

type Project = { key: string; name: string; path: string; rows: SessionSummary[]; newest: number };

/** Sessions by folder, newest folder first. */
function groupProjects(rows: SessionSummary[]): Project[] {
  const m = new Map<string, Project>();
  for (const s of rows) {
    const key = s.cwd || "";
    const p = m.get(key) ?? { key, name: s.project || "No folder", path: s.cwd ? shortPath(s.cwd) : "No folder", rows: [], newest: 0 };
    p.rows.push(s);
    p.newest = Math.max(p.newest, s.mtime);
    m.set(key, p);
  }
  return [...m.values()].sort((a, b) => b.newest - a.newest);
}

/** The Recents overflow: grouping, the agent filter, and the inline filter. */
function ViewMenu({
  groupBy,
  onGroupBy,
  agents,
  agent,
  onAgent,
  onFilter,
}: {
  groupBy: RecentsGroup;
  onGroupBy: (g: RecentsGroup) => void;
  agents: AgentId[];
  agent: AgentId | "all";
  onAgent: (a: AgentId | "all") => void;
  onFilter: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /* the list scrolls, so the menu floats in a portal, under the button or above it when space runs out */
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 300;
    const below = r.bottom + 4 + h <= window.innerHeight - 8;
    setPlace({
      position: "fixed",
      left: Math.max(8, r.right - 208),
      ...(below ? { top: r.bottom + 4 } : { top: Math.max(8, r.top - 4 - h) }),
      transformOrigin: below ? "top right" : "bottom right",
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const inside = (t: EventTarget | null) => t instanceof Node && Boolean(ref.current?.contains(t) || buttonRef.current?.contains(t));
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

  const pick = (fn: () => void) => () => {
    fn();
    setOpen(false);
    buttonRef.current?.focus();
  };
  const item = (checked: boolean, label: string, onClick: () => void) => (
    <button key={label} type="button" role="menuitemradio" aria-checked={checked} onClick={pick(onClick)} className="menu-item">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check width={15} height={15} strokeWidth={2} className="shrink-0 text-ink-2" aria-hidden />}
    </button>
  );
  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Recents options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex size-7 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,opacity] duration-150 hover:bg-sidebar-hover hover:text-ink group-hover/section:opacity-100 focus-visible:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100 ${open ? "bg-sidebar-hover text-ink opacity-100" : "opacity-0"}`}
      >
        <MoreHoriz width={16} height={16} strokeWidth={2} aria-hidden />
      </button>
      {open &&
        createPortal(
        <div
          ref={ref}
          role="menu"
          aria-label="Recents options"
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
          }}
          className="z-50 w-52 rounded-[12px] bg-surface p-1 shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", ...place, visibility: place.position ? "visible" : "hidden" }}
        >
          <button type="button" role="menuitem" onClick={pick(onFilter)} className="menu-item">
            <Search width={14} height={14} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Filter list…</span>
          </button>
          <div className="mx-2 my-1 h-px bg-line" />
          <div className="px-2 pt-1 pb-0.5 text-[12px] text-ink-3">Group recents by</div>
          {GROUPS.map((g) => item(groupBy === g, GROUP_LABEL[g], () => onGroupBy(g)))}
          {agents.length > 1 && (
            <>
              <div className="mx-2 my-1 h-px bg-line" />
              <div className="px-2 pt-1 pb-0.5 text-[12px] text-ink-3">Show</div>
              {item(agent === "all", "All agents", () => onAgent("all"))}
              {agents.map((a) => item(agent === a, AGENT_LABEL[a], () => onAgent(a)))}
            </>
          )}
        </div>,
          document.body,
        )}
    </div>
  );
}

const PROJECT_CAP = 6;
const PROJECT_ROWS_CAP = 8;
const RECENT_STEP = 40;

type SectionKey = "live" | "projects" | "recents";

export function SessionList({
  sessions,
  activeId,
  onPick,
  onNew,
  onCollapse,
  collapseLabel = "Close sidebar",
  error,
  onView,
  activeView,
}: {
  sessions: SessionSummary[] | null;
  activeId: string | null;
  /** kept for callers; open tabs no longer change how a row reads */
  openIds?: { id: string }[];
  onPick: (id: string) => void;
  onNew: () => void;
  /** desktop: fold the sidebar into the rail; phone: close the drawer */
  onCollapse?: () => void;
  collapseLabel?: string;
  error: string | null;
  /** opens the Agents or Files tab */
  onView?: (tab: "@agents" | "@files") => void;
  activeView?: string | null;
}) {
  const mod = useModKey();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [groupBy, setGroupBy] = useStored<RecentsGroup>("cui:recentsGroup", "none", GROUPS);
  const [agentFilter, setAgentFilter] = useStored<AgentId | "all">("cui:agent", "all");
  const [shut, setShut] = useState<Set<SectionKey>>(new Set());
  const [openProjects, setOpenProjects] = useState<Set<string>>(new Set());
  const [fullProjects, setFullProjects] = useState<Set<string>>(new Set());
  const [allProjects, setAllProjects] = useState(false);
  const [recentCap, setRecentCap] = useState(RECENT_STEP);
  const now = Date.now();

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cui:sidebarShut") ?? "[]") as SectionKey[];
      if (Array.isArray(saved)) setShut(new Set(saved));
    } catch {}
  }, []);
  const toggleSection = (k: SectionKey) =>
    setShut((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      try {
        localStorage.setItem("cui:sidebarShut", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const flip = (set: (fn: (s: Set<string>) => Set<string>) => void, key: string) =>
    set((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const agentsPresent = useMemo(() => [...new Set((sessions ?? []).map((s) => s.agent))], [sessions]);
  const filter = agentsPresent.includes(agentFilter as AgentId) ? agentFilter : "all";
  const rows = useMemo(() => (sessions ?? []).filter((s) => filter === "all" || s.agent === filter), [sessions, filter]);
  const live = useMemo(() => rows.filter(isLive), [rows]);
  const recent = useMemo(() => rows.filter((s) => !isLive(s)), [rows]);
  const projects = useMemo(() => groupProjects(rows), [rows]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return rows.filter((s) => `${s.title} ${s.cwd} ${AGENT_LABEL[s.agent]}`.toLowerCase().includes(q));
  }, [rows, query]);

  /* the active session's folder opens by itself */
  const activeProject = useMemo(() => (sessions ?? []).find((s) => s.id === activeId)?.cwd, [sessions, activeId]);
  useEffect(() => {
    if (activeProject === undefined) return;
    setOpenProjects((cur) => (cur.has(activeProject) ? cur : new Set(cur).add(activeProject)));
  }, [activeProject]);

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);
  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const shownProjects = allProjects ? projects : projects.filter((p, i) => i < PROJECT_CAP || p.key === activeProject);
  const recentGroups = groupRows(recent.slice(0, recentCap), groupBy, now);
  const palette = () => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));

  return (
    <nav aria-label="Sessions" className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-0.5 pr-2 pl-3.5">
        <Brand />
        <span className="ml-2 min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.015em] text-ink">agent-u</span>
        <IconButton label="Search" tip={`Search  ${mod} K`} onClick={palette}>
          <Search width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        {onCollapse && (
          <IconButton label={collapseLabel} tip={`${collapseLabel}  ${mod} B`} tipPos="bottom-end" onClick={onCollapse}>
            <SidebarCollapse width={18} height={18} strokeWidth={1.8} aria-hidden />
          </IconButton>
        )}
      </div>

      <div className="shrink-0 px-2 pb-1">
        <button type="button" onClick={onNew} className="side-row group/new">
          <EditPencil width={17} height={17} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
          <span className="min-w-0 flex-1 truncate">New session</span>
          <kbd className="hidden shrink-0 font-sans text-[12px] text-ink-3 opacity-0 transition-opacity duration-150 group-hover/new:opacity-100 group-focus-visible/new:opacity-100 pointer-fine:inline" aria-hidden>
            Alt T
          </kbd>
        </button>
        {onView && (
          <>
            <button type="button" onClick={() => onView("@agents")} aria-current={activeView === "@agents" ? "page" : undefined} className="side-row">
              <Terminal width={17} height={17} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Agents and terminals</span>
            </button>
            <button type="button" onClick={() => onView("@files")} aria-current={activeView === "@files" ? "page" : undefined} className="side-row">
              <Folder width={17} height={17} strokeWidth={1.8} className="shrink-0 text-ink-2" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Files</span>
            </button>
          </>
        )}
      </div>

      {searching && (
        <div className="shrink-0 px-2 pb-1">
          <label className="flex h-[34px] items-center rounded-control bg-sidebar-hover text-ink-3 focus-within:text-ink-2 pointer-coarse:h-10">
            <Search width={15} height={15} strokeWidth={1.9} className="ml-2.5 shrink-0" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                /* Enter opens the top match; Escape clears, then folds the field away */
                if (e.key === "Enter" && matches?.[0]) onPick(matches[0].id);
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
              className="ml-2 min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-[14px] sm:pointer-coarse:text-[16px] [&::-webkit-search-cancel-button]:hidden"
            />
            <button
              type="button"
              aria-label="Close filter"
              onMouseDown={(e) => e.preventDefault()}
              onClick={closeSearch}
              className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 hover:text-ink"
            >
              <Xmark width={14} height={14} strokeWidth={2} aria-hidden />
            </button>
          </label>
        </div>
      )}

      <div className="scroll-quiet scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2 pb-5">
        {error && (
          <p role="alert" className="mx-0.5 mb-2 rounded-control bg-red-tint px-2.5 py-2 text-[13px] text-red-ink">
            Couldn&apos;t load sessions: {error}
          </p>
        )}
        {filter !== "all" && !matches && (
          <div className="mb-1 flex h-8 items-center gap-1.5 px-2.5 text-[13px] text-ink-3">
            <span className="min-w-0 truncate">{AGENT_LABEL[filter]} sessions only</span>
            <button type="button" onClick={() => setAgentFilter("all")} className="tap relative shrink-0 rounded-chip font-medium text-accent-ink hover:underline">
              Show all
            </button>
          </div>
        )}
        {sessions === null && !error && (
          <div className="flex flex-col gap-px pt-8" role="status" aria-label="Loading sessions…">
            {[72, 58, 80, 64, 50, 68, 76].map((w, i) => (
              <div key={i} className="flex h-[34px] items-center px-2.5" style={{ animation: `fade-in 400ms ease ${i * 60}ms both` }}>
                <div className="h-2.5 rounded-full bg-sidebar-hover" style={{ width: `${w}%` }} />
              </div>
            ))}
          </div>
        )}

        {matches ? (
          <section className="mt-1">
            <h2 className="flex h-8 items-center px-2.5 text-[13px] text-ink-3">
              {matches.length ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : "No matches"}
            </h2>
            {matches.length ? (
              <div className="flex flex-col gap-px">
                {matches.map((s) => (
                  <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} lead={isLive(s) ? <PulseSlot s={s} /> : undefined} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-start gap-1 px-2.5 py-1">
                <p className="text-[13px] text-ink-3">
                  Nothing matches <span className="text-ink-2">“{query.trim()}”</span>.
                </p>
                <button type="button" onClick={() => setQuery("")} className="tap relative rounded-chip text-[13px] font-medium text-accent-ink hover:underline">
                  Clear filter
                </button>
              </div>
            )}
          </section>
        ) : (
          sessions !== null && (
            <>
              {live.length > 0 && (
                <Section label="Open now" open={!shut.has("live")} onToggle={() => toggleSection("live")}>
                  {live.map((s) => (
                    <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} lead={<PulseSlot s={s} />} />
                  ))}
                </Section>
              )}

              {projects.length > 0 && (
                <Section label="Projects" open={!shut.has("projects")} onToggle={() => toggleSection("projects")}>
                  {shownProjects.map((p) => {
                    const open = openProjects.has(p.key);
                    const full = fullProjects.has(p.key);
                    const list = full ? p.rows : p.rows.slice(0, PROJECT_ROWS_CAP);
                    return (
                      <div key={p.key} className="flex flex-col gap-px">
                        <button type="button" onClick={() => flip(setOpenProjects, p.key)} aria-expanded={open} title={p.path} className="side-row group/row">
                          <span className="relative flex size-[18px] shrink-0 items-center justify-center text-ink-2">
                            <Folder width={17} height={17} strokeWidth={1.7} aria-hidden className="transition-opacity duration-150 group-hover/row:opacity-0 group-focus-visible/row:opacity-0" />
                            <NavArrowRight
                              width={14}
                              height={14}
                              strokeWidth={2}
                              aria-hidden
                              className={`absolute opacity-0 transition-[opacity,transform] duration-150 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 ${open ? "rotate-90" : ""}`}
                            />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{p.rows.length}</span>
                        </button>
                        {open &&
                          (p.rows.length ? (
                            <>
                              {list.map((s) => (
                                <Row key={s.id} s={s} indent active={s.id === activeId} onPick={onPick} now={now} />
                              ))}
                              {p.rows.length > list.length && (
                                <button type="button" onClick={() => flip(setFullProjects, p.key)} className="side-row pl-[34px] text-[13px] text-ink-3">
                                  Show {p.rows.length - list.length} more
                                </button>
                              )}
                            </>
                          ) : (
                            <p className="flex h-8 items-center pl-[34px] text-[13px] text-ink-3">No sessions</p>
                          ))}
                      </div>
                    );
                  })}
                  {projects.length > shownProjects.length || allProjects ? (
                    projects.length > PROJECT_CAP && (
                      <button type="button" onClick={() => setAllProjects((v) => !v)} className="side-row text-[13px] text-ink-3">
                        <span className="flex size-[18px] shrink-0 items-center justify-center">
                          <MoreHoriz width={16} height={16} strokeWidth={2} aria-hidden />
                        </span>
                        {allProjects ? "Fewer projects" : `${projects.length - shownProjects.length} more projects`}
                      </button>
                    )
                  ) : null}
                </Section>
              )}

              <Section
                label="Recents"
                open={!shut.has("recents")}
                onToggle={() => toggleSection("recents")}
                action={
                  <ViewMenu
                    groupBy={groupBy}
                    onGroupBy={setGroupBy}
                    agents={agentsPresent}
                    agent={filter}
                    onAgent={setAgentFilter}
                    onFilter={() => setSearching(true)}
                  />
                }
              >
                {recentGroups.map(([name, list]) => (
                  <div key={name || "all"} className="flex flex-col gap-px">
                    {name && <h3 className="flex h-7 items-end px-2.5 pb-1 text-[12px] text-ink-3 [&:not(:first-child)]:mt-2">{name}</h3>}
                    {list.map((s) => (
                      <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} showAgent={groupBy !== "agent"} />
                    ))}
                  </div>
                ))}
                {recent.length > recentCap && (
                  <button type="button" onClick={() => setRecentCap((c) => c + RECENT_STEP)} className="side-row text-[13px] text-ink-3">
                    Show more
                  </button>
                )}
                {!recent.length && (
                  <p className="px-2.5 py-1.5 text-[13px] text-ink-3">
                    {rows.length ? "Everything is open right now." : filter !== "all" ? `No ${AGENT_LABEL[filter]} sessions yet.` : "No sessions yet. Start one with New session."}
                  </p>
                )}
              </Section>
            </>
          )
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <ThemeToggle />
        <IconButton
          label="Sign out"
          tipPos="bottom-end"
          onClick={async () => {
            await api("/api/auth/logout", {}).catch(() => undefined);
            window.location.href = "/login";
          }}
        >
          <LogOut width={17} height={17} strokeWidth={1.8} aria-hidden />
        </IconButton>
      </div>
    </nav>
  );
}

/* ── collapsed rail ─────────────────────────────────────── */

const RAIL_LIVE_CAP = 8;

/** The collapsed desktop sidebar: expand, new, search, and one mark per open session. */
export function SessionRail({
  sessions,
  activeId,
  onPick,
  onNew,
  onExpand,
  onView,
}: {
  sessions: SessionSummary[] | null;
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onExpand: () => void;
  onView?: (tab: "@agents" | "@files") => void;
}) {
  const mod = useModKey();
  const live = (sessions ?? []).filter(isLive);
  const shown = live.slice(0, RAIL_LIVE_CAP);
  return (
    <nav aria-label="Sessions" className="flex h-full w-full flex-col items-center">
      <div className="flex h-[52px] shrink-0 items-center">
        <button type="button" aria-label="Open sidebar" data-tip={`Open sidebar  ${mod} B`} data-tip-pos="right" onClick={onExpand} className="icon-btn group/brand">
          <span className="transition-opacity duration-150 group-hover/brand:opacity-0 group-focus-visible/brand:opacity-0">
            <Brand />
          </span>
          <SidebarExpand width={18} height={18} strokeWidth={1.8} aria-hidden className="absolute opacity-0 transition-opacity duration-150 group-hover/brand:opacity-100 group-focus-visible/brand:opacity-100" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-1">
        <IconButton label="New session" tip="New session  Alt T" tipPos="right" onClick={onNew}>
          <EditPencil width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        <IconButton label="Search" tip={`Search  ${mod} K`} tipPos="right" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))}>
          <Search width={18} height={18} strokeWidth={1.8} aria-hidden />
        </IconButton>
        {onView && (
          <>
            <IconButton label="Agents and terminals" tip="Agents and terminals" tipPos="right" onClick={() => onView("@agents")}>
              <Terminal width={18} height={18} strokeWidth={1.8} aria-hidden />
            </IconButton>
            <IconButton label="Files" tip="Files" tipPos="right" onClick={() => onView("@files")}>
              <Folder width={18} height={18} strokeWidth={1.8} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
      {shown.length > 0 && (
        <div className="mt-5 flex flex-col items-center gap-1" role="list" aria-label="Open now">
          {shown.map((s) => {
            const waiting = (s.web?.pending.length ?? 0) > 0;
            const on = s.id === activeId;
            const state = waiting ? "needs you" : isBusy(s) ? "working" : "open";
            return (
              <div role="listitem" key={s.id}>
                <button
                  type="button"
                  aria-label={`${s.title}, ${state}`}
                  aria-current={on ? "page" : undefined}
                  data-tip={s.title}
                  data-tip-pos="right"
                  onClick={() => onPick(s.id)}
                  className="icon-btn"
                >
                  <Pulse busy={isBusy(s)} size={3} cellClass={AGENT_TONE[s.agent]} />
                  {waiting && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-orange ring-2 ring-sidebar" aria-hidden />}
                </button>
              </div>
            );
          })}
          {live.length > shown.length && (
            <button type="button" onClick={onExpand} aria-label={`${live.length - shown.length} more open sessions`} data-tip="Show all" data-tip-pos="right" className="icon-btn text-[12px] font-medium tabular-nums">
              +{live.length - shown.length}
            </button>
          )}
        </div>
      )}
    </nav>
  );
}
