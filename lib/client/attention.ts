"use client";

/* The tab title and the installed app's badge both carry how many sessions are waiting on you. */

let base = "agent-u";
let count = 0;

const apply = () => {
  document.title = count ? `(${count}) ${base}` : base;
};

export function setBaseTitle(title: string) {
  base = title;
  apply();
}

export function setAttention(n: number) {
  if (n === count) return;
  count = n;
  apply();
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  void (n ? nav.setAppBadge?.(n) : nav.clearAppBadge?.())?.catch(() => undefined);
}
