"use client";

import { useEffect } from "react";

/* iOS Safari ignores `interactive-widget=resizes-content`: the on-screen keyboard covers the bottom of the page
 * instead of shrinking it. This keeps `--kb` on <html> at the height it covers (0 where the browser resizes the
 * page itself), so the shell and sheets can end above it. */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        /* small differences are toolbars sliding, not a keyboard */
        document.documentElement.style.setProperty("--kb", `${covered > 80 ? covered : 0}px`);
      });
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--kb");
    };
  }, []);
}
