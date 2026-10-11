"use client";

import { useEffect, useState, type RefObject } from "react";

/** The shimmering status label. Lives in classes (not inline styles) so reduced motion can swap it for plain text. */
export const SHIMMER =
  "bg-[linear-gradient(90deg,var(--ink-3)_35%,var(--ink)_50%,var(--ink-3)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent animate-[shimmer-text_1.4s_linear_infinite] motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-ink-2";

/** Strong ease-out used for enter animations across the thread. */
export const ENTER = { animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" } as const;

/**
 * True while the element is on screen and the tab is visible. Continuous
 * animations (shimmers, spinners) pause when this is false so nothing keeps
 * repainting where nobody can see it.
 */
export function useOnScreen(ref: RefObject<HTMLElement | null>, enabled = true) {
  const [inView, setInView] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const sync = () => setTabVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [enabled]);
  return inView && tabVisible;
}

/** Inline style that pauses a running CSS animation. */
export const pausedStyle = (paused: boolean) => (paused ? ({ animationPlayState: "paused" } as const) : undefined);
