"use client";

import { useEffect, useMemo, useState } from "react";
import { EditPencil, LogOut, NavArrowDown, Search, Xmark } from "iconoir-react";
import GlideMenu from "@/components/primitives/GlideMenu";
import { AGENT_LABEL, type AgentId, type SessionSummary } from "@/lib/types";
import { api, timeAgo } from "@/lib/client/api";
import { terminalBusy } from "@/lib/status";
import { Pulse } from "./Pulse";
import { ThemeToggle } from "./ThemeToggle";

export const isBusy = (s: Pick<SessionSummary, "terminal" | "web">) =>
  s.web ? s.web.status === "running" || s.web.status === "starting" : terminalBusy(s.terminal?.status);

const isLive = (s: SessionSummary) => Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");

function Row({ s, active, onPick, now }: { s: SessionSummary; active: boolean; onPick: (id: string) => void; now: number }) {
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
      className={`relative z-10 flex w-full items-start gap-2.5 rounded-[9px] px-2.5 py-2.5 text-left transition-colors duration-100 focus-visible:outline-offset-[-2px] sm:py-2 ${active ? "bg-hover-2" : ""}`}
    >
      {live && (
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          <Pulse busy={isBusy(s)} />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate text-[14px] font-medium ${active ? "text-ink" : "text-ink-2"}`}>{s.title}</span>
          {s.agent !== "claude" && <AgentBadge agent={s.agent} />}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-ink-3">
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

export function SessionList({
  sessions,
  activeId,
  onPick,
  onNew,
  error,
}: {
  sessions: SessionSummary[] | null;
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  error: string | null;
}) {
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useStored<GroupBy>("cui:groupBy", "time");
  const [agentFilter, setAgentFilter] = useStored<AgentId | "all">("cui:agent", "all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const now = Date.now();
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

  return (
    <nav aria-label="Sessions" className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <span className="flex size-7 items-center justify-center rounded-[8px] bg-ink">
          <Pulse busy={false} size={3.5} cellClass="bg-surface" />
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-ink">agent-u</span>
        <button
          type="button"
          onClick={onNew}
          aria-label="New session"
          className="tap relative ml-auto flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-ink shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.97] sm:h-8 sm:text-[12.5px]"
        >
          <EditPencil width={14} height={14} strokeWidth={1.9} aria-hidden />
          <span aria-hidden>New</span>
        </button>
      </div>

      <div className="px-3 pb-2">
        <label className="flex h-10 items-center gap-2 rounded-[10px] bg-field pr-1 pl-2.5 text-ink-3 shadow-hairline transition-shadow duration-150 focus-within:text-ink-2 focus-within:shadow-[0_0_0_1px_var(--line-strong)] sm:h-9">
          <Search width={15} height={15} strokeWidth={1.9} className="shrink-0" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              /* Enter opens the top match; Escape clears */
              const first = live[0] ?? recent[0];
              if (e.key === "Enter" && query && first) onPick(first.id);
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            type="search"
            enterKeyHint="go"
            placeholder="Search sessions…"
            name="session-search"
            autoComplete="off"
            aria-label="Search sessions"
            className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 sm:text-[13px] sm:pointer-coarse:text-[16px] [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="tap relative flex size-8 shrink-0 items-center justify-center rounded-[7px] hover:bg-hover hover:text-ink sm:size-7">
              <Xmark width={14} height={14} strokeWidth={2} />
            </button>
          )}
        </label>
      </div>

      <div className="flex items-center gap-1 px-3 pb-2 text-[12px]">
        <div className="flex rounded-full bg-field p-0.5" role="radiogroup" aria-label="Group sessions by">
          {(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={groupBy === g}
              onClick={() => setGroupBy(g)}
              className={`tap relative h-6 rounded-full px-2.5 font-medium transition-colors duration-150 ${groupBy === g ? "bg-surface text-ink shadow-btn" : "text-ink-3 hover:text-ink-2"}`}
            >
              {GROUP_LABEL[g]}
            </button>
          ))}
        </div>
        {agentsPresent.length > 1 && (
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value as AgentId | "all")}
            aria-label="Filter by agent"
            className="ml-auto h-7 rounded-full bg-field px-2 text-[12px] font-medium text-ink-2 outline-none"
          >
            <option value="all">All agents</option>
            {agentsPresent.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABEL[a]}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-3">
        {error && (
          <p role="alert" className="mx-1.5 mb-2 rounded-[8px] bg-red-tint px-2.5 py-2 text-[12.5px] text-red-ink">
            Couldn&apos;t load sessions: {error}
          </p>
        )}
        {sessions === null && !error && (
          <div className="flex flex-col pt-1" role="status" aria-label="Loading sessions…">
            <div className="mx-2.5 mt-1 mb-2.5 h-2.5 w-16 rounded-full bg-hover" />
            {[72, 58, 80, 64, 50, 68].map((w, i) => (
              <div key={i} className="flex flex-col gap-1.5 px-2.5 py-2.5 sm:py-2" style={{ animation: `fade-in 400ms ease ${i * 60}ms both` }}>
                <div className="h-3 rounded-full bg-hover-2" style={{ width: `${w}%` }} />
                <div className="h-2.5 rounded-full bg-hover" style={{ width: `${w * 0.55}%` }} />
              </div>
            ))}
          </div>
        )}
        {live.length > 0 && (
          <section className="mb-3">
            <h2 className="px-2.5 pt-1 pb-1 text-[12px] font-medium text-ink-3">Open now</h2>
            <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[9px] bg-hover">
              {live.map((s) => (
                <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} />
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
                  className="flex w-full items-center gap-1.5 rounded-[7px] px-2.5 pt-1 pb-1 text-left text-[12px] font-medium text-ink-3 hover:text-ink-2"
                >
                  <NavArrowDown width={11} height={11} strokeWidth={2.4} className={`shrink-0 transition-transform duration-200 ${shut ? "-rotate-90" : ""}`} aria-hidden />
                  <span className="min-w-0 truncate">{name}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-ink-3/80">{rows.length}</span>
                </button>
              </h2>
              {!shut && (
                <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[9px] bg-hover">
                  {rows.map((s) => (
                    <Row key={s.id} s={s} active={s.id === activeId} onPick={onPick} now={now} />
                  ))}
                </GlideMenu>
              )}
            </section>
          );
        })}
        {sessions !== null && !live.length && !recent.length && (
          <div className="flex flex-col items-start gap-2 px-2.5 py-3">
            <p className="text-[13px] text-ink-3">
              {query ? (
                <>
                  No sessions match <span className="font-medium text-ink-2">“{query.trim()}”</span>.
                </>
              ) : (
                "No sessions yet. Start one with New."
              )}
            </p>
            {query && (
              <button type="button" onClick={() => setQuery("")} className="tap relative -ml-1 rounded-full px-1 text-[12.5px] font-medium text-accent-ink hover:underline">
                Clear search
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-line px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
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
