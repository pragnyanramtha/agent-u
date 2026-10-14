import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { StreamDelta } from "@/lib/types";
import { activeProfile } from "../profiles";
import type { CliRunState } from "./types";

/* Web-driven turns for CLI agents: each send/start spawns the agent's
 * non-interactive mode (e.g. `codex app-server`, `opencode run`, `cursor-agent -p`)
 * and tracks it here, keyed "<agent>:<sessionId>". One turn per session at a
 * time; the transcript on disk stays the source of truth for content.
 *
 * While a turn runs, adapters can also push live text/thinking deltas parsed
 * from the CLI's output (emitDelta / liveStream). They are buffered for the
 * turn so a client that connects late (e.g. right after starting a session)
 * gets the text so far, and dropped when the turn ends: by then the persisted
 * entries have taken over. */

export type Run = {
  child: ChildProcess;
  state: CliRunState;
  stderr: string;
  listeners: Set<(s: CliRunState) => void>;
  /** current key (changes when a new session's id becomes known) */
  key: string;
  /** live deltas of this turn, accumulated per stream ("<msgId>\0<index>") */
  deltas: Map<string, StreamDelta>;
};

const runs: Map<string, Run> = (() => {
  const g = globalThis as typeof globalThis & { __cliRuns?: Map<string, Run> };
  return (g.__cliRuns ??= new Map());
})();

const deltaListeners: Map<string, Set<(d: StreamDelta) => void>> = (() => {
  const g = globalThis as typeof globalThis & { __cliDeltaListeners?: Map<string, Set<(d: StreamDelta) => void>> };
  return (g.__cliDeltaListeners ??= new Map());
})();

/** streams kept per turn for late subscribers; the oldest go first */
const MAX_STREAMS = 200;

export type SpawnSpec = {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** written to stdin, which is then closed */
  stdin?: string;
  /** keep stdin open as a pipe (for JSON-RPC style drivers); the adapter writes to `run.child.stdin` */
  keepStdin?: boolean;
};

/**
 * Spawns one turn. `onStdout` sees each stdout line (adapters parse JSON event
 * streams here, e.g. to learn a new session id); `onChunk` sees raw decoded
 * stdout as it arrives (for plain-text output). Throws if a turn is already
 * running for the key.
 */
export function startTurn(key: string, spec: SpawnSpec, onStdout?: (line: string) => void, onChunk?: (text: string) => void): Run {
  const existing = runs.get(key);
  if (existing?.state.status === "running") throw new Error("A turn is already running for this session.");
  const piped = spec.keepStdin || spec.stdin !== undefined;
  /* a profile (another backend, an API key, a proxy) adds its global flags and environment */
  const profile = activeProfile();
  const child = spawn(spec.cmd, [...(profile?.args ?? []), ...spec.args], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env, ...profile?.env },
    stdio: [piped ? "pipe" : "ignore", "pipe", "pipe"],
    detached: false,
  });
  const run: Run = {
    child,
    state: { status: "running", error: null, startedAt: Date.now() },
    stderr: "",
    listeners: existing?.listeners ?? new Set(),
    key,
    deltas: new Map(),
  };
  runs.set(key, run);
  const emit = () => run.listeners.forEach((fn) => fn(run.state));
  /* writes after the child exited must not crash the server */
  child.stdin?.on("error", () => undefined);
  if (spec.stdin !== undefined && !spec.keepStdin) child.stdin?.end(spec.stdin);
  let buf = "";
  const decoder = new StringDecoder("utf8");
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (!text) return;
    onChunk?.(text);
    buf += text;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onStdout?.(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    run.stderr = (run.stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.on("error", (err) => {
    run.state = { ...run.state, status: "error", error: err.message };
    run.deltas.clear();
    emit();
  });
  child.on("exit", (code, signal) => {
    const tail = decoder.end();
    if (tail) onChunk?.(tail);
    buf += tail;
    if (buf.trim()) onStdout?.(buf.trim());
    buf = "";
    if (run.state.status !== "running") return;
    run.state =
      code === 0 || signal === "SIGTERM"
        ? { ...run.state, status: "idle" }
        : { ...run.state, status: "error", error: lastLine(run.stderr) || `Exited with code ${code}` };
    run.deltas.clear();
    emit();
  });
  emit();
  return run;
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";

export const turnState = (key: string) => runs.get(key)?.state ?? null;

/** Re-key a run (a new session whose id is only known after the CLI starts). Live deltas follow the run. */
export function rekeyTurn(from: string, to: string) {
  const run = runs.get(from);
  if (!run || from === to) return;
  runs.delete(from);
  /* keep state listeners someone attached to the final key before the run moved there */
  const waiting = runs.get(to);
  if (waiting && waiting !== run) waiting.listeners.forEach((fn) => run.listeners.add(fn));
  run.key = to;
  runs.set(to, run);
  /* anyone already watching the final key gets the text so far */
  const fns = deltaListeners.get(to);
  if (fns?.size) for (const d of run.deltas.values()) fns.forEach((fn) => fn({ ...d }));
}

export function stopTurn(key: string) {
  const run = runs.get(key);
  if (run?.state.status === "running") run.child.kill("SIGTERM");
}

export function onTurn(key: string, fn: (s: CliRunState) => void) {
  let run = runs.get(key);
  if (!run) {
    run = {
      child: undefined as unknown as ChildProcess,
      state: { status: "idle", error: null, startedAt: 0 },
      stderr: "",
      listeners: new Set(),
      key,
      deltas: new Map(),
    };
    runs.set(key, run);
  }
  run.listeners.add(fn);
  const r = run;
  return () => r.listeners.delete(fn);
}

/* ---------- live deltas ---------- */

/** Appends live text to the running turn under `key` and tells its subscribers. Ignored once the turn ended. */
export function emitDelta(key: string, delta: StreamDelta) {
  const run = runs.get(key);
  if (!run || run.state.status !== "running" || !delta.text) return;
  const k = `${delta.msgId}\0${delta.index}`;
  const prev = run.deltas.get(k);
  if (prev) prev.text += delta.text;
  else {
    run.deltas.set(k, { ...delta });
    if (run.deltas.size > MAX_STREAMS) run.deltas.delete(run.deltas.keys().next().value!);
  }
  deltaListeners.get(key)?.forEach((fn) => fn(delta));
}

/** Live deltas for `key`. A turn already running replays its text so far first (one delta per stream). */
export function onDelta(key: string, fn: (d: StreamDelta) => void): () => void {
  let set = deltaListeners.get(key);
  if (!set) deltaListeners.set(key, (set = new Set()));
  set.add(fn);
  const run = runs.get(key);
  /* `?.`: runs that outlived a dev hot reload predate the buffer */
  if (run?.state.status === "running") for (const d of run.deltas?.values() ?? []) fn({ ...d });
  const own = set;
  return () => {
    own.delete(fn);
    if (!own.size && deltaListeners.get(key) === own) deltaListeners.delete(key);
  };
}

/**
 * Per-turn writer for adapters: `push(segment, kind, text)` appends to the live
 * stream of one assistant message/part ("segment", any id unique within the
 * turn). msgIds are "live:<key at start>:<turn start>:<segment>", which the
 * client recognises as replaceable by persisted entries. Follows rekeys.
 */
export function liveStream(run: Run) {
  const base = `live:${run.key}:${run.state.startedAt.toString(36)}`;
  return {
    push(segment: string | number, kind: StreamDelta["kind"], text: string) {
      if (text) emitDelta(run.key, { msgId: `${base}:${segment}`, index: 0, kind, text });
    },
  };
}
