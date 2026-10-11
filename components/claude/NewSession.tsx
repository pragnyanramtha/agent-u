"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Folder, Menu } from "iconoir-react";
import LoadingState from "@/components/primitives/LoadingState";
import { AGENT_LABEL, type AgentId, type PermissionMode, type SessionSummary } from "@/lib/types";
import { api, ApiError, shortPath } from "@/lib/client/api";
import { Composer } from "./Composer";
import { Pulse } from "./Pulse";
import { isBusy } from "./SessionList";

/* The harness entrance (greeting, question, composer, then the rest), with
 * the same staggered blur-up reveal Beautiful UI uses on its home screen. */
const REVEAL = { offsetY: 23, blur: 17, duration: 800, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };
const reveal = (visible: boolean): CSSProperties => ({
  opacity: visible ? 1 : 0,
  transform: visible ? "translate3d(0,0,0)" : `translate3d(0,${REVEAL.offsetY}px,0)`,
  filter: visible ? "blur(0px)" : `blur(${REVEAL.blur}px)`,
  transition: ["opacity", "transform", "filter"].map((p) => `${p} ${REVEAL.duration}ms ${REVEAL.easing}`).join(", "),
});

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function NewSession({
  projects,
  sessions,
  onMenu,
  onOpen,
}: {
  projects: string[];
  sessions: SessionSummary[] | null;
  onMenu: () => void;
  onOpen: (id: string) => void;
}) {
  const [stage, setStage] = useState(0);
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [model, setModel] = useState("");
  const [agent, setAgent] = useState<AgentId>("claude");
  const [agents, setAgents] = useState<{ id: AgentId; label: string; installed: boolean }[]>([]);
  useEffect(() => {
    const saved = localStorage.getItem("cui:newAgent") as AgentId | null;
    if (saved) setAgent(saved);
    api<{ agents: { id: AgentId; label: string; installed: boolean }[] }>("/api/agents")
      .then((d) => setAgents(d.agents))
      .catch(() => undefined);
  }, []);
  const pickAgent = (a: AgentId) => {
    setAgent(a);
    setModel("");
    localStorage.setItem("cui:newAgent", a);
  };
  const name = AGENT_LABEL[agent];
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hello, setHello] = useState("");
  const folderRef = useRef<HTMLInputElement>(null);
  /* once the user edits the folder, never refill it behind their back */
  const touched = useRef(false);

  useEffect(() => {
    setHello(greeting());
    if (!touched.current) setCwd((c) => c || localStorage.getItem("cui:lastCwd") || "");
    /* reduced motion: show everything at once, no blur-up */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStage(4);
      return;
    }
    const timers = [170, 330, 400, 550].map((t, i) => setTimeout(() => setStage(i + 1), t));
    return () => timers.forEach(clearTimeout);
  }, []);

  /* prefill once with the most recent project; after that an empty field stays empty */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || touched.current || !projects[0]) return;
    prefilled.current = true;
    setCwd((c) => c || projects[0]);
  }, [projects]);

  const live = (sessions ?? []).filter((s) => s.terminal || (s.web && s.web.status !== "closed")).slice(0, 4);

  const start = async (text: string) => {
    setError(null);
    if (!cwd.trim()) {
      setError("Choose a folder for Claude to work in.");
      folderRef.current?.focus();
      return false;
    }
    setStarting(true);
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { agent, cwd: cwd.trim(), text, model: model || undefined, permissionMode: mode });
      localStorage.setItem("cui:lastCwd", cwd.trim());
      onOpen(id);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the session.");
      setStarting(false);
      return false;
    }
  };

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="safe-top flex shrink-0 items-center px-[max(0.375rem,env(safe-area-inset-left))] lg:hidden">
        <div className="flex h-14 items-center">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="flex size-10 items-center justify-center rounded-[10px] text-ink-2 hover:bg-hover hover:text-ink">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full max-w-[720px] flex-col justify-center px-4 py-8 sm:px-8 sm:py-10">
          <h1 className="text-[26px] font-normal tracking-[-0.02em] text-ink">
            <span className="home-reveal block text-ink-3" style={reveal(stage >= 1)}>
              {hello || "\u00a0"}
            </span>
            <span className="home-reveal block" style={reveal(stage >= 2)}>
              What should {name} work on?
            </span>
          </h1>

          <div className="home-reveal mt-7 flex flex-col gap-2.5" style={reveal(stage >= 3)}>
            <label
              className={`flex h-11 items-center gap-2 rounded-[12px] bg-field px-3 text-ink-3 transition-shadow duration-150 focus-within:text-ink-2 sm:h-10 ${
                error && !cwd.trim() ? "shadow-[0_0_0_1px_var(--red)]" : "shadow-hairline focus-within:shadow-[0_0_0_1px_var(--line-strong)]"
              }`}
            >
              <Folder width={16} height={16} strokeWidth={1.8} className="shrink-0" aria-hidden />
              <span className="sr-only">Working folder on the server</span>
              <input
                ref={folderRef}
                value={cwd}
                onChange={(e) => {
                  touched.current = true;
                  setCwd(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  /* Enter moves on to the task box */
                  if (e.key === "Enter") {
                    e.preventDefault();
                    document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")?.focus();
                  }
                }}
                enterKeyHint="next"
                aria-invalid={Boolean(error && !cwd.trim())}
                aria-describedby={error ? "new-session-error" : undefined}
                list="cui-projects"
                name="cwd"
                autoComplete="off"
                translate="no"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="Folder on the server…"
                className="min-w-0 flex-1 bg-transparent font-mono text-[16px] text-ink outline-none placeholder:font-sans placeholder:text-ink-3 sm:text-[13px] sm:pointer-coarse:text-[16px]"
              />
              <datalist id="cui-projects">
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {shortPath(p)}
                  </option>
                ))}
              </datalist>
            </label>
            {agents.length > 1 && (
              <div className="no-scrollbar -mx-1 flex items-center gap-1 overflow-x-auto px-1" role="radiogroup" aria-label="Agent">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={agent === a.id}
                    disabled={!a.installed}
                    title={a.installed ? undefined : `${a.label} isn't installed on the server`}
                    onClick={() => pickAgent(a.id)}
                    className={`tap relative h-8 shrink-0 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-150 disabled:opacity-40 ${
                      agent === a.id ? "bg-ink text-surface" : "bg-field text-ink-2 shadow-hairline hover:text-ink"
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            {starting ? (
              <div className="flex h-[118px] items-center justify-center rounded-[22px] border border-line bg-surface shadow-card" role="status">
                <LoadingState label={`Starting ${name}…`} variant="Dots" />
              </div>
            ) : (
              <Composer
                draftKey="new"
                placeholder="Describe the task…"
                onSend={start}
                running={false}
                slashCommands={[]}
                mode={mode}
                onModeChange={setMode}
                model={model || null}
                onModelChange={setModel}
                models={agent === "claude" ? undefined : [{ key: "", name: "Default" }]}
                cwd={agent === "claude" ? cwd.trim() || undefined : undefined}
                autoFocus
              />
            )}
            {error && (
              <p id="new-session-error" role="alert" className="rounded-[10px] bg-red-tint px-3 py-2 text-[13px] text-red-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                {error}
              </p>
            )}
          </div>

          {live.length > 0 && (
            <div className="home-reveal mt-8" style={reveal(stage >= 4)}>
              <h2 className="mb-1 text-[12.5px] font-medium text-ink-3">Open now</h2>
              <div className="flex flex-col">
                {live.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onOpen(s.id)}
                    title={s.title}
                    className="-mx-2 flex min-h-11 items-center gap-3 rounded-control px-2 py-3 text-left transition-colors duration-150 hover:bg-hover sm:min-h-0 sm:py-2.5"
                  >
                    <Pulse busy={isBusy(s)} />
                    <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{s.title}</span>
                    {(s.web?.pending.length ?? 0) > 0 && (
                      <span className="shrink-0 whitespace-nowrap rounded-full bg-orange-tint px-1.5 py-0.5 text-[11px] font-medium text-orange-ink">Needs you</span>
                    )}
                    <span className="max-w-[30%] shrink-0 truncate text-[12.5px] text-ink-3">{s.web ? "web" : s.terminal?.multiplexer ?? "terminal"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
