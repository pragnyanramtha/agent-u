"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessions } from "@/lib/client/useSessions";
import { CommandPalette, OPEN_TERMINAL_EVENT } from "./CommandPalette";
import { WebTerminal, type TerminalTarget } from "./WebTerminal";
import { NewSession } from "./NewSession";
import { SessionList } from "./SessionList";
import { SessionScreen } from "./SessionScreen";

const readId = () => new URLSearchParams(window.location.search).get("s");

export function App() {
  const [id, setId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  /* the sidebar's theme pill reads the theme once on mount; remount it after the palette flips the theme */
  const [themeKey, setThemeKey] = useState(0);
  const onTheme = useCallback(() => setThemeKey((k) => k + 1), []);
  const { sessions, projects, error, refresh } = useSessions();
  const [terminal, setTerminal] = useState<TerminalTarget | null>(null);
  useEffect(() => {
    const open = (e: Event) => setTerminal((e as CustomEvent<TerminalTarget>).detail);
    window.addEventListener(OPEN_TERMINAL_EVENT, open);
    return () => window.removeEventListener(OPEN_TERMINAL_EVENT, open);
  }, []);

  useEffect(() => {
    setId(readId());
    setReady(true);
    const onPop = () => setId(readId());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback(
    (next: string | null, replace = false) => {
      const url = next ? `/?s=${next}` : "/";
      if (replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
      setId(next);
      setDrawer(false);
      void refresh();
    },
    [refresh],
  );

  /* Drawer: focus moves in on open and back to the menu button on close,
   * Escape closes, the page behind can't scroll, and it closes itself if the
   * window grows into the desktop layout. */
  useEffect(() => {
    if (!drawer) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = drawerRef.current;
    const target = panel?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel;
    target?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onWide = () => desktop.matches && setDrawer(false);
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    desktop.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", onWide);
      root.style.overflow = overflow;
      /* after a pick the old screen is gone, so fall back to the new screen's menu button */
      const back = opener?.isConnected ? opener : document.querySelector<HTMLElement>("[data-drawer-opener]");
      requestAnimationFrame(() => back?.focus({ preventScroll: true }));
    };
  }, [drawer]);

  const list = <SessionList key={themeKey} sessions={sessions} activeId={id} onPick={(s) => go(s)} onNew={() => go(null)} error={error} />;

  return (
    <main className="flex h-[100dvh] bg-canvas text-ink lg:gap-2.5 lg:p-2.5">
      <aside className="hidden w-[288px] shrink-0 lg:flex">{list}</aside>

      <div
        className={`fixed inset-0 z-40 lg:hidden ${drawer ? "" : "pointer-events-none"}`}
        aria-hidden={!drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
      >
        <div
          className="absolute inset-0 touch-none bg-black/50 transition-opacity duration-300"
          style={{ opacity: drawer ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
          onClick={() => setDrawer(false)}
        />
        <div
          ref={drawerRef}
          tabIndex={-1}
          className="safe-top absolute inset-y-0 left-0 flex w-[86%] max-w-[330px] overscroll-contain bg-canvas pl-[env(safe-area-inset-left)] shadow-overlay outline-none"
          style={{
            transform: drawer ? "translateX(0)" : "translateX(-104%)",
            /* visible at once on open (so focus can land), hidden only after the slide out */
            visibility: drawer ? "visible" : "hidden",
            transition: `transform 300ms cubic-bezier(0.23, 1, 0.32, 1)${drawer ? "" : ", visibility 0s linear 300ms"}`,
          }}
          inert={!drawer}
        >
          {list}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-page lg:rounded-[14px] lg:border lg:border-line" inert={drawer}>
        {!ready ? null : id ? (
          <SessionScreen key={id} id={id} onMenu={() => setDrawer(true)} onNavigate={(next) => go(next, true)} onNew={() => go(null)} />
        ) : (
          <NewSession projects={projects} sessions={sessions} onMenu={() => setDrawer(true)} onOpen={(s) => go(s)} />
        )}
      </div>

      {terminal && <WebTerminal target={terminal} onClose={() => setTerminal(null)} />}
      <CommandPalette sessions={sessions} activeId={id} onOpen={(s) => go(s)} onNew={() => go(null)} onTheme={onTheme} />
    </main>
  );
}
