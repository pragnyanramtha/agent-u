"use client";

import { useEffect, useState } from "react";
import { HalfMoon, SunLight } from "iconoir-react";

/* Browser chrome color for each theme, matched to --page. Keep in sync with app/layout.tsx. */
const THEME_COLOR = { dark: "#17181a", light: "#fafafb" } as const;

/** Beautiful UI's sun/moon segmented pill. */
export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setDark(localStorage.getItem("bui-theme") !== "light");
    } catch {
      setDark(document.documentElement.classList.contains("dark"));
    }
  }, []);

  function apply(next: boolean) {
    if (next === dark) return;
    setDark(next);
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.classList.toggle("dark", next);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next ? THEME_COLOR.dark : THEME_COLOR.light);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
    try {
      localStorage.setItem("bui-theme", next ? "dark" : "light");
    } catch {}
  }

  const seg = "relative z-10 flex size-8 items-center justify-center rounded-full transition-colors duration-150 pointer-coarse:size-9";
  return (
    <div className="relative inline-grid h-9 grid-cols-2 items-center rounded-full bg-field p-0.5 pointer-coarse:h-10" role="group" aria-label="Theme">
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 w-8 rounded-full bg-surface shadow-btn transition-transform duration-200 [--seg:32px] pointer-coarse:w-9 pointer-coarse:[--seg:36px]"
        style={{ transform: dark ? "translateX(var(--seg))" : "translateX(0)", transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)", opacity: dark === null ? 0 : 1 }}
      />
      <button type="button" aria-label="Light theme" aria-pressed={dark === false} onClick={() => apply(false)} className={`${seg} ${dark ? "text-ink-3 hover:text-ink-2" : "text-ink"}`}>
        <SunLight width={14} height={14} strokeWidth={2} />
      </button>
      <button type="button" aria-label="Dark theme" aria-pressed={dark === true} onClick={() => apply(true)} className={`${seg} ${dark ? "text-ink" : "text-ink-3 hover:text-ink-2"}`}>
        <HalfMoon width={14} height={14} strokeWidth={2} />
      </button>
    </div>
  );
}
