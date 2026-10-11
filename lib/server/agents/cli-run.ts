import { spawn, type ChildProcess } from "node:child_process";
import type { CliRunState } from "./types";

/* Web-driven turns for CLI agents: each send/start spawns the agent's
 * non-interactive mode (e.g. `codex exec`, `opencode run`, `cursor-agent -p`)
 * and tracks it here, keyed "<agent>:<sessionId>". One turn per session at a
 * time; the transcript on disk stays the source of truth for content. */

type Run = { child: ChildProcess; state: CliRunState; stderr: string; listeners: Set<(s: CliRunState) => void> };

const runs = (() => {
  const g = globalThis as typeof globalThis & { __cliRuns?: Map<string, Run> };
  return (g.__cliRuns ??= new Map());
})();

export type SpawnSpec = { cmd: string; args: string[]; cwd: string; env?: Record<string, string>; stdin?: string };

/**
 * Spawns one turn. `onStdout` sees each stdout line (adapters parse JSON event
 * streams here, e.g. to learn a new session id). Throws if a turn is already
 * running for the key.
 */
export function startTurn(key: string, spec: SpawnSpec, onStdout?: (line: string) => void): Run {
  const existing = runs.get(key);
  if (existing?.state.status === "running") throw new Error("A turn is already running for this session.");
  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: false,
  });
  const run: Run = { child, state: { status: "running", error: null, startedAt: Date.now() }, stderr: "", listeners: existing?.listeners ?? new Set() };
  runs.set(key, run);
  const emit = () => run.listeners.forEach((fn) => fn(run.state));
  if (spec.stdin !== undefined) child.stdin?.end(spec.stdin);
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
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
    emit();
  });
  child.on("exit", (code, signal) => {
    if (buf.trim()) onStdout?.(buf.trim());
    if (run.state.status !== "running") return;
    run.state =
      code === 0 || signal === "SIGTERM"
        ? { ...run.state, status: "idle" }
        : { ...run.state, status: "error", error: lastLine(run.stderr) || `Exited with code ${code}` };
    emit();
  });
  emit();
  return run;
}

const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";

export const turnState = (key: string) => runs.get(key)?.state ?? null;

/** Re-key a run (a new session whose id is only known after the CLI starts). */
export function rekeyTurn(from: string, to: string) {
  const run = runs.get(from);
  if (!run || from === to) return;
  runs.delete(from);
  runs.set(to, run);
}

export function stopTurn(key: string) {
  const run = runs.get(key);
  if (run?.state.status === "running") run.child.kill("SIGTERM");
}

export function onTurn(key: string, fn: (s: CliRunState) => void) {
  let run = runs.get(key);
  if (!run) {
    run = { child: undefined as unknown as ChildProcess, state: { status: "idle", error: null, startedAt: 0 }, stderr: "", listeners: new Set() };
    runs.set(key, run);
  }
  run.listeners.add(fn);
  const r = run;
  return () => r.listeners.delete(fn);
}
