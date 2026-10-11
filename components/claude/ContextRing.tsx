"use client";

import { useEffect, useRef, useState } from "react";
import type { Entry } from "@/lib/types";

export type ContextUsage = Extract<Entry, { kind: "usage" }>;

/* Claude Code 2.x runs current models with a 1M window; older claude-3 models had 200k. */
export const contextWindow = (u: ContextUsage) => (/claude-3/.test(u.model) && u.input + u.cacheRead + u.cacheWrite <= 200_000 ? 200_000 : 1_000_000);

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** The context the latest turn saw, as a ring in the composer rail; tap or hover for the breakdown. */
export function ContextRing({ usage, costUsd = null }: { usage: ContextUsage | null; costUsd?: number | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!usage) return null;
  const used = usage.input + usage.cacheRead + usage.cacheWrite;
  const window = contextWindow(usage);
  const pct = Math.min(1, used / window);
  const tone = pct >= 0.9 ? "var(--red)" : pct >= 0.7 ? "var(--orange)" : "var(--ink-2)";
  const r = 7;
  const c = 2 * Math.PI * r;
  const rows: [string, number][] = [
    ["Cached", usage.cacheRead],
    ["Newly cached", usage.cacheWrite],
    ["Uncached input", usage.input],
  ];

  return (
    <div ref={ref} className="relative" onMouseEnter={() => matchMedia("(hover: hover)").matches && setOpen(true)} onMouseLeave={() => matchMedia("(hover: hover)").matches && setOpen(false)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Context: ${Math.round(pct * 100)}% used, ${k(used)} of ${k(window)} tokens`}
        aria-expanded={open}
        className="tap relative flex h-9 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-ink-3 tabular-nums transition-colors duration-150 hover:bg-hover hover:text-ink-2 sm:h-7"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(pct * c, pct > 0 ? 1.5 : 0)} ${c}`}
            className="transition-[stroke-dasharray] duration-500"
          />
        </svg>
        <span className="hidden sm:inline">{Math.round(pct * 100)}%</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Context usage"
          className="absolute right-0 bottom-full z-30 mb-2 w-64 rounded-[12px] bg-surface p-3 text-[12.5px] shadow-raised"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "bottom right" }}
        >
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-ink">Context</span>
            <span className="text-ink-2 tabular-nums">
              {k(used)} / {k(window)}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-inset">
            <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct * 100}%`, background: tone }} />
          </div>
          <dl className="mt-3 flex flex-col gap-1.5">
            {rows.map(([label, n]) => (
              <div key={label} className="flex justify-between">
                <dt className="text-ink-3">{label}</dt>
                <dd className="text-ink-2 tabular-nums">{k(n)}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-line pt-1.5">
              <dt className="text-ink-3">Last reply</dt>
              <dd className="text-ink-2 tabular-nums">{k(usage.output)} out</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-3">Free</dt>
              <dd className="text-ink-2 tabular-nums">
                {k(Math.max(0, window - used))} ({Math.round((1 - pct) * 100)}%)
              </dd>
            </div>
          </dl>
          {costUsd !== null && (
            <div className="mt-1.5 flex justify-between text-[12.5px]">
              <span className="text-ink-3">Web run cost</span>
              <span className="text-ink-2 tabular-nums">${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}</span>
            </div>
          )}
          {usage.model && <p className="mt-2.5 truncate font-mono text-[11px] text-ink-3">{usage.model}</p>}
          {pct >= 0.8 && <p className="mt-1.5 text-[12px] text-orange-ink">Getting full. /compact frees space.</p>}
        </div>
      )}
    </div>
  );
}
