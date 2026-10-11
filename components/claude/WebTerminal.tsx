"use client";

import { useEffect, useRef, useState } from "react";
import { Xmark } from "iconoir-react";
import "@xterm/xterm/css/xterm.css";

export type TerminalTarget = { session?: string; pid?: number; cwd?: string; label: string };

/* keys phones don't have; sent as raw terminal sequences */
const KEYS: [string, string][] = [
  ["Esc", "\x1b"],
  ["Tab", "\t"],
  ["⇧Tab", "\x1b[Z"],
  ["Ctrl-C", "\x03"],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
  ["Enter", "\r"],
];

const THEME = {
  background: "#17181a",
  foreground: "#e6e8ec",
  cursor: "#e6e8ec",
  selectionBackground: "#3a3d44",
  black: "#1d1e21",
  brightBlack: "#6b7079",
};

/**
 * A full interactive terminal: a shell on the server, or the zellij/tmux
 * session a Claude session runs in (shared with your other clients).
 * Full screen on phones, a large sheet on desktop.
 */
export function WebTerminal({ target, onClose }: { target: TerminalTarget; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [reason, setReason] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      /* xterm measures glyphs on a canvas, which can't resolve CSS variables: use the real family, once loaded */
      const mono = getComputedStyle(document.body).getPropertyValue("--font-mono-face").trim();
      if (mono) await Promise.all([document.fonts.load(`13px ${mono}`), document.fonts.load(`bold 13px ${mono}`)]).catch(() => undefined);
      if (disposed || !hostRef.current) return;
      const term = new Terminal({
        fontFamily: `${mono ? `${mono}, ` : ""}ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
        lineHeight: 1.15,
        fontSize: window.matchMedia("(max-width: 640px)").matches ? 12 : 13,
        cursorBlink: true,
        scrollback: 5000,
        theme: THEME,
        allowProposedApi: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      const q = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) });
      if (target.pid) q.set("pid", String(target.pid));
      else if (target.session) q.set("session", target.session);
      if (target.cwd) q.set("cwd", target.cwd);
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/pty?${q}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      setState("connecting");
      setReason(null);

      const send = (data: string) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "input", data }));
      ws.onopen = () => {
        setState("open");
        term.focus();
      };
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
      ws.onclose = (e) => {
        setState("closed");
        setReason(e.code === 1000 ? "The terminal exited." : e.reason || "Disconnected.");
      };
      const onData = term.onData(send);
      const onResize = term.onResize(({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols, rows })));
      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* hidden */
        }
      });
      ro.observe(hostRef.current);
      cleanup = () => {
        ro.disconnect();
        onData.dispose();
        onResize.dispose();
        ws.close();
        term.dispose();
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [target.session, target.pid, target.cwd, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* Escape belongs to the terminal; Ctrl+Shift+X closes the sheet */
      if (e.key.toLowerCase() === "x" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const press = (seq: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: seq }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 lg:items-center lg:p-6" role="dialog" aria-modal="true" aria-label={`Terminal: ${target.label}`}>
      <div
        className="safe-top safe-bottom flex w-full flex-col overflow-hidden bg-[#17181a] shadow-overlay lg:h-[min(86dvh,900px)] lg:max-w-[1200px] lg:rounded-[14px] lg:border lg:border-line"
        style={{ animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-[12.5px] text-[#c9ccd3]">
          <span className={`size-2 shrink-0 rounded-full ${state === "open" ? "bg-green" : state === "connecting" ? "animate-pulse bg-orange" : "bg-red"}`} aria-hidden />
          <span className="font-medium text-[#e6e8ec]">Terminal</span>
          <span className="min-w-0 truncate font-mono text-[11.5px] text-[#8b909a]">{target.label}</span>
          {state === "closed" && (
            <button type="button" onClick={() => setAttempt((a) => a + 1)} className="ml-2 shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-[12px] font-medium text-[#e6e8ec] hover:bg-white/15">
              Reconnect
            </button>
          )}
          <span className="ml-auto hidden shrink-0 text-[11px] text-[#6b7079] lg:inline">Ctrl+Shift+X to close</span>
          <button type="button" onClick={onClose} aria-label="Close terminal" className="tap relative flex size-8 shrink-0 items-center justify-center rounded-[8px] text-[#8b909a] hover:bg-white/10 hover:text-[#e6e8ec]">
            <Xmark width={16} height={16} strokeWidth={2} />
          </button>
        </div>
        {state === "closed" && reason && <p className="shrink-0 bg-red/10 px-3 py-1.5 text-[12px] text-[#f2a7a7]">{reason}</p>}
        <div ref={hostRef} className="min-h-0 flex-1 px-1.5 pt-1.5" />
        <div className="no-scrollbar flex shrink-0 items-center gap-1 overflow-x-auto border-t border-white/10 px-2 py-1.5 lg:hidden" role="toolbar" aria-label="Terminal keys">
          {KEYS.map(([label, seq]) => (
            <button
              key={label}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => press(seq)}
              className="h-8 shrink-0 rounded-[7px] bg-white/[0.06] px-2.5 font-mono text-[12px] text-[#c9ccd3] active:bg-white/15"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
