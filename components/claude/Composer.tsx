"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, NavArrowDown } from "iconoir-react";
import GlideMenu from "@/components/primitives/GlideMenu";
import { APP_COMMANDS, rankCommands, type SlashItem } from "@/lib/commands";
import { ContextRing, type ContextUsage } from "./ContextRing";
import type { PermissionMode } from "@/lib/types";

/* The composer from Beautiful UI's PromptBar (tall variant), wired for Claude:
 * slash commands from the live session, a permission-mode picker, a model
 * picker, and send / stop. */

export const MODES: { key: PermissionMode; name: string; short: string; desc: string }[] = [
  { key: "default", name: "Ask before acting", short: "Ask first", desc: "Approve edits and commands here" },
  { key: "acceptEdits", name: "Accept edits", short: "Accept edits", desc: "File edits go through, commands still ask" },
  { key: "plan", name: "Plan only", short: "Plan", desc: "Read and propose, no changes" },
  { key: "bypassPermissions", name: "Bypass approvals", short: "Bypass", desc: "Everything runs without asking" },
];

export const MODELS = [
  { key: "", name: "Default" },
  { key: "opus", name: "Opus" },
  { key: "sonnet", name: "Sonnet" },
  { key: "haiku", name: "Haiku" },
];

export function modelLabel(model: string | null) {
  if (!model) return "Default";
  const m = /claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}`;
  return MODELS.find((x) => x.key === model)?.name ?? model;
}

type Menu = "slash" | "mode" | "model" | null;

const KIND_LABEL: Record<SlashItem["kind"], string> = { app: "This app", builtin: "Claude Code", command: "Your commands", skill: "Skills" };

const MENU_W = { mode: 256, model: 224 };

function MenuShell({ children, left, width }: { children: React.ReactNode; left?: number; width?: number }) {
  const full = width === undefined;
  return (
    <div
      className={`no-scrollbar absolute bottom-full z-20 mb-2 max-h-[min(26rem,52dvh)] overflow-y-auto overscroll-contain rounded-[12px] bg-surface p-1 shadow-raised ${full ? "inset-x-0" : "max-w-full"}`}
      style={{ left: full ? undefined : left ?? 0, width, animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom left" }}
    >
      {children}
    </div>
  );
}

/** Arrow keys, Home and End move focus between a menu's items. */
function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
  if (!items.length) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "ArrowDown" ? (at + 1) % items.length : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  items[next].focus();
}

const chip = "tap relative flex h-9 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium transition-colors duration-150 sm:h-7 sm:text-[12px]";

export function Composer({
  draftKey,
  placeholder,
  onSend,
  running,
  onStop,
  slashCommands,
  mode,
  onModeChange,
  model,
  onModelChange,
  notice,
  autoFocus,
  cwd,
  onAppCommand,
  usage = null,
  costUsd = null,
}: {
  draftKey: string;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  running: boolean;
  onStop?: () => void;
  slashCommands: string[];
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  model: string | null;
  onModelChange: (model: string) => void;
  notice?: React.ReactNode;
  autoFocus?: boolean;
  /** folder whose project commands and skills to offer */
  cwd?: string;
  /** browser-side commands (/model, /mode, /stop, /new, /end); return true when handled */
  onAppCommand?: (name: string, arg: string) => boolean;
  /** latest turn's token usage, shown as the context ring */
  usage?: ContextUsage | null;
  costUsd?: number | null;
}) {
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<Menu>(null);
  const [slashHidden, setSlashHidden] = useState(false);
  const [menuLeft, setMenuLeft] = useState(0);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [catalog, setCatalog] = useState<SlashItem[]>([]);

  /* commands and skills on disk, so the menu works before the session is running */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/commands${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)
      .then((r) => (r.ok ? r.json() : { commands: [] }))
      .then((d: { commands: SlashItem[] }) => !cancelled && setCatalog(d.commands ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  /* drafts survive reloads and switching sessions */
  useEffect(() => {
    setDraft(sessionStorage.getItem(`draft:${draftKey}`) ?? "");
  }, [draftKey]);
  useEffect(() => {
    if (draft) sessionStorage.setItem(`draft:${draftKey}`, draft);
    else sessionStorage.removeItem(`draft:${draftKey}`);
  }, [draft, draftKey]);

  useEffect(() => {
    if (autoFocus && window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus();
  }, [autoFocus, draftKey]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 200)}px`;
    el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
  }, [draft]);

  const slashQuery = /^\/([\w:-]*)$/.exec(draft)?.[1];
  const allCommands = useMemo(() => {
    const known = new Set(catalog.map((c) => c.name));
    const live = slashCommands.filter((n) => !known.has(n)).map((name): SlashItem => ({ name, description: "", kind: "command" }));
    return [...(onAppCommand ? APP_COMMANDS : []), ...catalog, ...live];
  }, [catalog, slashCommands, onAppCommand]);
  const commands = slashQuery === undefined ? [] : rankCommands(allCommands, slashQuery);
  const openMenu: Menu = menu ?? (slashQuery !== undefined && !slashHidden ? "slash" : null);

  useEffect(() => setActive(0), [slashQuery]);

  /* close on Escape, outside taps, or focus leaving the composer; return focus to the trigger */
  const closeMenu = useCallback(
    (refocus: boolean) => {
      const trigger = menu === "mode" ? modeRef.current : menu === "model" ? modelRef.current : inputRef.current;
      setMenu(null);
      setSlashHidden(true);
      if (refocus) trigger?.focus();
    },
    [menu],
  );

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeMenu(rootRef.current?.contains(document.activeElement) ?? false);
    };
    const onFocus = (e: FocusEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) closeMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [openMenu, closeMenu]);

  /* mode and model menus take focus on the checked item so arrows work right away */
  useEffect(() => {
    if (menu !== "mode" && menu !== "model") return;
    const el = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]');
    el?.focus({ preventScroll: true });
  }, [menu]);

  const toggleMenu = (which: "mode" | "model") => {
    if (menu === which) return closeMenu(false);
    const root = rootRef.current?.getBoundingClientRect();
    const trigger = (which === "mode" ? modeRef.current : modelRef.current)?.getBoundingClientRect();
    if (root && trigger) setMenuLeft(Math.max(0, Math.min(trigger.left - root.left - 4, root.width - MENU_W[which])));
    setMenu(which);
  };

  const canSend = draft.trim().length > 0 && !sending;
  const send = async () => {
    if (!canSend) return;
    const text = draft.trim();
    const app = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text);
    if (app && onAppCommand && APP_COMMANDS.some((c) => c.name === app[1]) && onAppCommand(app[1], (app[2] ?? "").trim())) {
      setDraft("");
      return;
    }
    setSending(true);
    setDraft("");
    const ok = await onSend(text).catch(() => false);
    if (!ok) setDraft(text);
    setSending(false);
  };

  const pickCommand = (c: string) => {
    setDraft(`/${c} `);
    setMenu(null);
    inputRef.current?.focus();
  };

  const currentMode = MODES.find((m) => m.key === mode) ?? MODES[0];
  const slashOpen = openMenu === "slash";

  return (
    <div ref={rootRef} className="relative w-full" data-composer>
      {slashOpen && (
        <MenuShell>
          <div role="listbox" id={`${uid}-slash`} aria-label="Slash commands">
            {commands.map((c, i) => {
              const header = i === 0 || commands[i - 1].kind !== c.kind ? KIND_LABEL[c.kind] : null;
              return (
                <div key={`${c.kind}:${c.name}`}>
                  {header && !slashQuery && <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-ink-3">{header}</p>}
                  <button
                    id={`${uid}-cmd-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    tabIndex={-1}
                    ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pickCommand(c.name)}
                    className={`flex w-full min-w-0 items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-75 sm:py-1.5 ${i === active ? "bg-hover" : ""}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-2.5">
                      <span className="shrink-0 font-mono text-[13px] text-ink sm:text-[12.5px]" translate="no">
                        /{c.name}
                        {c.hint && <span className="text-ink-3"> {c.hint}</span>}
                      </span>
                      {c.description && <span className="min-w-0 truncate text-[12px] text-ink-3">{c.description}</span>}
                    </span>
                    {slashQuery ? <span className="shrink-0 text-[10.5px] font-medium text-ink-3">{KIND_LABEL[c.kind]}</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
          {commands.length === 0 && (
            <p className="px-2.5 py-2 text-[12.5px] text-ink-3">{allCommands.length ? `No command matches “${slashQuery}”.` : "Loading commands…"}</p>
          )}
        </MenuShell>
      )}

      {openMenu === "mode" && (
        <MenuShell left={menuLeft} width={MENU_W.mode}>
          <div ref={menuRef} role="menu" id={`${uid}-mode`} aria-label="Permission mode" onKeyDown={moveFocus}>
            <GlideMenu className="flex flex-col" highlightClassName="inset-x-0 rounded-[8px] bg-hover">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={m.key === mode}
                  data-menu-row
                  onClick={() => {
                    onModeChange(m.key);
                    closeMenu(true);
                  }}
                  className="relative z-10 flex w-full items-start gap-2 rounded-[8px] px-2.5 py-2 text-left focus-visible:outline-offset-[-2px]"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`text-[13px] font-medium ${m.key === mode ? "text-accent-ink" : "text-ink"}`}>{m.name}</span>
                    <span className="text-[12px] text-ink-3">{m.desc}</span>
                  </span>
                  {m.key === mode && <Check width={15} height={15} strokeWidth={2.2} className="mt-0.5 shrink-0 text-accent-ink" aria-hidden />}
                </button>
              ))}
            </GlideMenu>
          </div>
        </MenuShell>
      )}

      {openMenu === "model" && (
        <MenuShell left={menuLeft} width={MENU_W.model}>
          <div ref={menuRef} role="menu" id={`${uid}-model`} aria-label="Model" onKeyDown={moveFocus}>
            <GlideMenu className="flex flex-col" highlightClassName="inset-x-0 rounded-[8px] bg-hover">
              {MODELS.map((m) => {
                const on = m.key === (model && MODELS.some((x) => x.key === model) ? model : "");
                return (
                  <button
                    key={m.key || "default"}
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    data-menu-row
                    onClick={() => {
                      onModelChange(m.key);
                      closeMenu(true);
                    }}
                    className="relative z-10 flex h-10 w-full items-center gap-2 rounded-[8px] px-2.5 text-left text-[13px] font-medium text-ink focus-visible:outline-offset-[-2px] sm:h-8"
                  >
                    <span className={on ? "text-accent-ink" : ""}>{m.name}</span>
                    {m.key === "" && model && !MODELS.some((x) => x.key === model) && <span className="truncate text-[12px] font-normal text-ink-3">{modelLabel(model)}</span>}
                    {on && <Check width={15} height={15} strokeWidth={2.2} className="ml-auto shrink-0 text-accent-ink" aria-hidden />}
                  </button>
                );
              })}
            </GlideMenu>
          </div>
        </MenuShell>
      )}

      <div className="relative flex flex-col gap-1 rounded-[22px] border border-line bg-surface p-2.5 shadow-card transition-[border-color] duration-150 focus-within:border-line-strong sm:p-3">
        {notice}
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSlashHidden(false);
            if (menu === "mode" || menu === "model") setMenu(null);
          }}
          onKeyDown={(e) => {
            if (slashOpen && commands.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => (a + (e.key === "ArrowDown" ? 1 : commands.length - 1)) % commands.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !draft.includes(" "))) {
                e.preventDefault();
                pickCommand(commands[active].name);
                return;
              }
            }
            /* Enter is a newline; Ctrl/Cmd+Enter sends */
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
          aria-label="Message Claude"
          aria-controls={slashOpen ? `${uid}-slash` : undefined}
          aria-activedescendant={slashOpen && commands.length ? `${uid}-cmd-${active}` : undefined}
          aria-autocomplete="list"
          enterKeyHint="send"
          className="w-full resize-none bg-transparent px-1.5 py-2 text-[16px] leading-6 text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 sm:text-[14px] sm:pointer-coarse:text-[16px] sm:leading-5 sm:pointer-coarse:leading-6"
        />
        <div className="flex min-w-0 items-center gap-1">
          <button
            ref={modeRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={openMenu === "mode"}
            aria-controls={openMenu === "mode" ? `${uid}-mode` : undefined}
            aria-label={`Permission mode: ${currentMode.name}`}
            onClick={() => toggleMenu("mode")}
            onKeyDown={(e) => {
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && menu !== "mode") {
                e.preventDefault();
                toggleMenu("mode");
              }
            }}
            className={`${chip} shrink-0 ${
              mode === "bypassPermissions"
                ? "bg-orange-tint text-orange-ink"
                : mode === "plan"
                  ? "bg-accent-tint text-accent-ink"
                  : openMenu === "mode"
                    ? "bg-hover text-ink"
                    : "text-ink-2 hover:bg-hover hover:text-ink"
            }`}
          >
            <span className="whitespace-nowrap">{currentMode.short}</span>
            <NavArrowDown width={11} height={11} strokeWidth={2.4} className="shrink-0" />
          </button>
          <button
            ref={modelRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={openMenu === "model"}
            aria-controls={openMenu === "model" ? `${uid}-model` : undefined}
            aria-label={`Model: ${modelLabel(model)}`}
            onClick={() => toggleMenu("model")}
            onKeyDown={(e) => {
              if ((e.key === "ArrowUp" || e.key === "ArrowDown") && menu !== "model") {
                e.preventDefault();
                toggleMenu("model");
              }
            }}
            className={`${chip} min-w-0 ${openMenu === "model" ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
          >
            <span className="truncate">{modelLabel(model)}</span>
            <NavArrowDown width={11} height={11} strokeWidth={2.4} className="shrink-0" />
          </button>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
            <ContextRing usage={usage} costUsd={costUsd} />
            {running && onStop && (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop Claude"
                title="Stop"
                className="tap relative flex size-9 items-center justify-center rounded-[10px] text-ink-2 shadow-btn transition-[background-color,transform] duration-150 hover:bg-hover active:scale-[0.94] sm:size-8"
              >
                <span className="size-2.5 rounded-[2px] bg-current" />
              </button>
            )}
            <button
              type="button"
              aria-label={sending ? "Sending…" : "Send (Ctrl+Enter)"}
              title="Send (Ctrl+Enter)"
              disabled={!canSend}
              onClick={() => void send()}
              className="tap relative flex size-9 items-center justify-center rounded-[10px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] sm:size-8"
              style={{ background: canSend ? "var(--ink)" : "var(--line-strong)", color: canSend ? "var(--surface)" : "var(--ink-2)" }}
            >
              <ArrowUp width={17} height={17} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
