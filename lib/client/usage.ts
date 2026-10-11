/* Pure usage/cost/timing helpers over a session's entries. No React, no I/O. */

import type { Entry, RunState } from "@/lib/types";

export type UsageEntry = Extract<Entry, { kind: "usage" }>;
export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number };

/* ── context window ───────────────────────────────────────── */

/** Tokens the request saw: uncached input plus cache reads and writes. */
export const contextUsed = (u: Tokens) => u.input + u.cacheRead + u.cacheWrite;

/* Claude Code 2.x runs current models with a 1M window; older claude-3 models had 200k. */
export const contextWindow = (u: UsageEntry) => (/claude-3/.test(u.model) && contextUsed(u) <= 200_000 ? 200_000 : 1_000_000);

export type ContextState = { used: number; window: number; pct: number; cached: number; newlyCached: number; uncached: number; free: number; output: number; model: string };

export function contextOf(u: UsageEntry): ContextState {
  const used = contextUsed(u);
  const window = contextWindow(u);
  return { used, window, pct: Math.min(1, used / window), cached: u.cacheRead, newlyCached: u.cacheWrite, uncached: u.input, free: Math.max(0, window - used), output: u.output, model: u.model };
}

/** Ring / bar tone for how full the window is. */
export const contextTone = (pct: number) => (pct >= 0.9 ? "var(--red)" : pct >= 0.7 ? "var(--orange)" : "var(--ink-2)");

export function latestUsage(entries: Entry[]): UsageEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "usage") return e;
  }
  return null;
}

/** Context size after every API call, for the growth sparkline. Compactions show up as drops. */
export function contextSeries(entries: Entry[]): { t: number; used: number }[] {
  const out: { t: number; used: number }[] = [];
  for (const e of entries) if (e.kind === "usage") out.push({ t: Date.parse(e.ts) || 0, used: contextUsed(e) });
  return out;
}

/* ── prices (USD per million tokens) ──────────────────────── */

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number; label: string; fallback: boolean };

const p = (label: string, input: number, output: number, cacheRead: number, cacheWrite: number, fallback = false): Price => ({ label, input, output, cacheRead, cacheWrite, fallback });

/* list prices; OpenAI has no cache-write surcharge, so writes bill as plain input there */
const OPUS_OLD = p("Opus 3 to 4.1", 15, 75, 1.5, 18.75);
const OPUS = p("Opus 4.5+", 5, 25, 0.5, 6.25);
const SONNET_4 = p("Sonnet 3.5 to 4.6", 3, 15, 0.3, 3.75);
const SONNET_5 = p("Sonnet 5", 2, 10, 0.2, 2.5);
const HAIKU_45 = p("Haiku 4.5", 1, 5, 0.1, 1.25);
const HAIKU_35 = p("Haiku 3.5", 0.8, 4, 0.08, 1);
const HAIKU_3 = p("Haiku 3", 0.25, 1.25, 0.03, 0.3);
const GPT_5 = p("GPT-5 / 5.1", 1.25, 10, 0.125, 1.25);
const GPT_52 = p("GPT-5.2 / 5.3", 1.75, 14, 0.175, 1.75);
const GPT_54 = p("GPT-5.4", 2.5, 15, 0.25, 2.5);
const GPT_MINI = p("GPT-5 mini", 0.25, 2, 0.025, 0.25);
const GPT_NANO = p("GPT-5 nano", 0.05, 0.4, 0.005, 0.05);
const CODEX_MINI = p("Codex mini", 1.5, 6, 0.375, 1.5);
const O_SERIES = p("o3 / GPT-4.1", 2, 8, 0.5, 2);
const O_MINI = p("o4-mini", 1.1, 4.4, 0.275, 1.1);
const GEMINI_PRO = p("Gemini Pro", 1.25, 10, 0.125, 1.25);
const GEMINI_FLASH = p("Gemini Flash", 0.3, 2.5, 0.03, 0.3);
export const FALLBACK_PRICE = p("Generic rate", 3, 15, 0.3, 3.75, true);

/** "opus-4-5-20251101" -> [4, 5]; "claude-3-5-sonnet" -> [3, 5]. Dates (8 digits) are not minors. */
function version(model: string, family: string): [number, number] | null {
  const after = new RegExp(`${family}[-_ ]?(\\d{1,2})(?!\\d)(?:[-.](\\d{1,2})(?!\\d))?`).exec(model);
  if (after) return [Number(after[1]), Number(after[2] ?? 0)];
  const before = /claude-(\d)(?:[-.](\d))?-/.exec(model);
  return before ? [Number(before[1]), Number(before[2] ?? 0)] : null;
}

/** Best-guess list price for a model id; unknown models get a clearly flagged generic rate. */
export function priceFor(model: string): Price {
  const m = model.toLowerCase();
  if (m.includes("opus")) {
    const [maj, min] = version(m, "opus") ?? [4, 5];
    return maj >= 5 || (maj === 4 && min >= 5) ? OPUS : OPUS_OLD;
  }
  if (m.includes("sonnet")) {
    const [maj] = version(m, "sonnet") ?? [4, 0];
    return maj >= 5 ? SONNET_5 : SONNET_4;
  }
  if (m.includes("haiku")) {
    const [maj, min] = version(m, "haiku") ?? [4, 5];
    return maj >= 4 ? HAIKU_45 : maj === 3 && min >= 5 ? HAIKU_35 : HAIKU_3;
  }
  if (/codex-mini/.test(m)) return CODEX_MINI;
  const gpt = /gpt-5(?:\.(\d+))?/.exec(m);
  if (gpt) {
    if (/nano/.test(m)) return GPT_NANO;
    if (/mini/.test(m)) return GPT_MINI;
    const minor = Number(gpt[1] ?? 0);
    return minor >= 4 ? GPT_54 : minor >= 2 ? GPT_52 : GPT_5;
  }
  if (/\bo4-mini|o3-mini/.test(m)) return O_MINI;
  if (/\bo3\b|gpt-4\.1/.test(m)) return O_SERIES;
  if (/gemini.*flash/.test(m)) return GEMINI_FLASH;
  if (/gemini/.test(m)) return GEMINI_PRO;
  return FALLBACK_PRICE;
}

export const costOf = (t: Tokens, price: Price) => (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite) / 1_000_000;

/* ── session totals ───────────────────────────────────────── */

export type TokenTotals = Tokens & { calls: number };
export type ModelLine = TokenTotals & { model: string; price: Price; usd: number; share: number };
export type UsageTotals = TokenTotals & {
  models: ModelLine[];
  /** estimated USD across every loaded usage entry */
  estUsd: number;
  /** true when any model fell back to the generic rate */
  fallback: boolean;
  /** share of context tokens served from cache (reads / everything the model saw) */
  cacheHit: number;
  turns: number;
};

const zero = (): TokenTotals => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 });

export function usageTotals(entries: Entry[]): UsageTotals {
  const all = zero();
  const by = new Map<string, TokenTotals>();
  let turns = 0;
  for (const e of entries) {
    if (e.kind === "user") turns++;
    if (e.kind !== "usage") continue;
    const key = e.model || "unknown";
    const t = by.get(key) ?? zero();
    for (const x of [all, t]) {
      x.input += e.input;
      x.cacheRead += e.cacheRead;
      x.cacheWrite += e.cacheWrite;
      x.output += e.output;
      x.calls++;
    }
    by.set(key, t);
  }
  const lines = [...by].map(([model, t]) => {
    const price = priceFor(model === "unknown" ? "" : model);
    return { ...t, model, price, usd: costOf(t, price), share: 0 };
  });
  const estUsd = lines.reduce((s, l) => s + l.usd, 0);
  for (const l of lines) l.share = estUsd > 0 ? l.usd / estUsd : lines.length ? 1 / lines.length : 0;
  lines.sort((a, b) => b.usd - a.usd);
  const seen = contextUsed(all);
  return { ...all, models: lines, estUsd, fallback: lines.some((l) => l.price.fallback), cacheHit: seen > 0 ? all.cacheRead / seen : 0, turns };
}

export type SessionCost = {
  /** what to show as "the" cost: the run's reported cost when there is one, else the estimate */
  usd: number;
  estimated: boolean;
  /** estimate from the loaded transcript, always computed */
  estUsd: number;
  /** reported by the Claude Agent SDK for the web run, null elsewhere */
  actualUsd: number | null;
  fallback: boolean;
};

export function sessionCost(entries: Entry[], run: RunState | null, totals: UsageTotals = usageTotals(entries)): SessionCost {
  const actual = run?.costUsd ?? null;
  return { usd: actual ?? totals.estUsd, estimated: actual === null, estUsd: totals.estUsd, actualUsd: actual, fallback: totals.fallback };
}

/* ── turn timing ──────────────────────────────────────────── */

export type TurnTiming = {
  id: string;
  ts: string;
  text: string;
  /** user entry to the last entry before the next user turn; null when nothing followed yet */
  durationMs: number | null;
  output: number;
  calls: number;
  tools: number;
  /** output tokens over the whole turn's wall time (tool runs included); null when not meaningful */
  tokensPerSec: number | null;
  /** the latest turn, which may still be running */
  open: boolean;
};

export function turnTimings(entries: Entry[]): TurnTiming[] {
  const turns: TurnTiming[] = [];
  let cur: TurnTiming | null = null;
  let last = "";
  const close = () => {
    if (!cur) return;
    const start = Date.parse(cur.ts);
    const end = last ? Date.parse(last) : NaN;
    cur.durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
    cur.tokensPerSec = cur.durationMs !== null && cur.durationMs >= 1000 && cur.output > 0 ? cur.output / (cur.durationMs / 1000) : null;
    turns.push(cur);
  };
  for (const e of entries) {
    if (e.kind === "user") {
      close();
      cur = { id: e.id, ts: e.ts, text: e.text, durationMs: null, output: 0, calls: 0, tools: 0, tokensPerSec: null, open: false };
      last = "";
      continue;
    }
    if (!cur || e.kind === "result") continue;
    if (e.ts) last = e.ts;
    if (e.kind === "usage") {
      cur.output += e.output;
      cur.calls++;
    } else if (e.kind === "tool") cur.tools++;
  }
  close();
  if (turns.length) turns[turns.length - 1].open = true;
  return turns;
}

/* ── formatting ───────────────────────────────────────────── */

export const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(Math.round(n));

export const fmtUsd = (n: number) => (n === 0 ? "$0.00" : n < 0.01 ? `$${n.toFixed(4)}` : n < 1000 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString("en-US")}`);

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const fmtPct = (x: number) => (x > 0 && x < 0.01 ? "<1%" : `${Math.round(x * 100)}%`);
