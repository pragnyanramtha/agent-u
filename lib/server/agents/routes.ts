import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import type { AgentId, PermissionMode, ServerEvent } from "@/lib/types";
import { parseMode, str } from "../http";
import { InputRefused, inputTarget, typeIntoTerminal } from "../input";
import { terminalOf, toRunState } from "./bridge";
import { onDelta, onTurn } from "./cli-run";
import { adapterFor, sessionKey } from "./index";

/* Route handlers for non-Claude sessions (ids "<agent>:<nativeId>").
 * Same wire shapes as the Claude routes, so the client doesn't care which agent it is. */

const notFound = () => NextResponse.json({ error: "Session not found" }, { status: 404 });
const modes = new Map<string, PermissionMode>();

export async function agentHistory(agent: AgentId, native: string, before: string | null) {
  const a = await adapterFor(agent);
  if (!a) return notFound();
  const key = sessionKey(agent, native);
  if (before !== null) {
    const page = await a.history(native, before);
    return NextResponse.json({ entries: page.entries, cursor: page.cursor });
  }
  const [session, terminal] = await Promise.all([a.get(native), terminalOf(a, native)]);
  if (!session && !a.runState(native)) return notFound();
  const page = await a.history(native, null);
  return NextResponse.json({
    type: "history",
    entries: page.entries,
    cursor: page.cursor,
    end: page.end,
    terminal,
    run: toRunState(key, a.runState(native), modes.get(key) ?? "default", session?.model ?? null),
    title: session?.title || `New ${a.label} session`,
    cwd: session?.cwd ?? "",
    permissionMode: modes.get(key) ?? null,
    agent,
  });
}

export async function agentEvents(req: NextRequest, agent: AgentId, native: string, from: string | null) {
  const a = await adapterFor(agent);
  if (!a) return new Response("Session not found", { status: 404 });
  const key = sessionKey(agent, native);
  const encoder = new TextEncoder();
  let closed = false;
  const cleanups: (() => void)[] = [];
  const cleanup = () => {
    if (closed) return;
    closed = true;
    cleanups.splice(0).forEach((fn) => fn());
  };
  const [session, terminal] = await Promise.all([a.get(native), terminalOf(a, native)]);
  const start = from ?? (await a.history(native, null)).end;

  const body = new ReadableStream({
    start(controller) {
      const send = (event: ServerEvent, id?: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const runOf = () => toRunState(key, a.runState(native), modes.get(key) ?? "default", session?.model ?? null);
      send({ type: "history", entries: [], cursor: null, terminal, run: runOf(), title: session?.title || `New ${a.label} session`, cwd: session?.cwd ?? "", permissionMode: modes.get(key) ?? null });
      cleanups.push(a.watch(native, start, (entries, end) => entries.length && send({ type: "entries", entries }, end)));
      cleanups.push(onTurn(key, () => send({ type: "run", run: runOf() })));
      /* live text of a web-driven turn; a running turn replays its text so far right after the history event */
      cleanups.push(onDelta(key, (delta) => send({ type: "delta", delta })));
      let last = JSON.stringify(terminal);
      const tick = setInterval(async () => {
        const t = await terminalOf(a, native).catch(() => null);
        const k = JSON.stringify(t);
        if (k !== last) {
          last = k;
          send({ type: "terminal", terminal: t });
        }
      }, 3000);
      const ping = setInterval(() => send({ type: "ping" }), 15_000);
      cleanups.push(() => {
        clearInterval(tick);
        clearInterval(ping);
      });
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

/** Same routing rule as Claude: an open terminal gets the keystrokes, otherwise the CLI resumes non-interactively. */
export async function agentMessage(agent: AgentId, native: string, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return notFound();
  const text = str(body.text)?.trim();
  if (!text) return NextResponse.json({ error: "Message is empty." }, { status: 400 });
  const key = sessionKey(agent, native);
  const mode = parseMode(body.permissionMode) ?? modes.get(key) ?? "default";
  modes.set(key, mode);

  const terminal = await terminalOf(a, native);
  if (terminal) {
    const target = await inputTarget(terminal.pid);
    if (!target) return NextResponse.json({ error: `This ${a.label} session runs in a terminal the web can't type into.`, code: "no_pane" }, { status: 409 });
    try {
      /* the prompt check reads Claude's input box; other TUIs look different, so type directly */
      const { queued } = await typeIntoTerminal(target, text, { checkPrompt: false });
      return NextResponse.json({ id: key, via: "terminal", queued });
    } catch (err) {
      if (err instanceof InputRefused) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      return NextResponse.json({ error: `Couldn't type into the terminal: ${err instanceof Error ? err.message.slice(0, 160) : err}` }, { status: 502 });
    }
  }
  if (a.runState(native)?.status === "running") return NextResponse.json({ error: `${a.label} is still working on the last message. Wait for it to finish.`, code: "busy" }, { status: 409 });
  try {
    await a.send(native, text, { model: str(body.model) || undefined, mode });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
  return NextResponse.json({ id: key, via: "web" });
}

export async function agentStart(agent: AgentId, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return NextResponse.json({ error: "Unknown agent." }, { status: 400 });
  if (!(await a.binary())) return NextResponse.json({ error: `${a.label} isn't installed on the server.` }, { status: 400 });
  const text = str(body.text)?.trim();
  const cwd = str(body.cwd)?.trim();
  if (!text) return NextResponse.json({ error: "Write a first message to start the session." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: `No folder at ${cwd || "(empty)"} on the server.` }, { status: 400 });
  }
  const mode = parseMode(body.permissionMode) ?? "default";
  try {
    const { id } = await Promise.race([
      a.start({ cwd, text, model: str(body.model) || undefined, mode }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${a.label} didn't start within 90 seconds.`)), 90_000)),
    ]);
    modes.set(sessionKey(agent, id), mode);
    return NextResponse.json({ id: sessionKey(agent, id) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

export async function agentControl(agent: AgentId, native: string, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return notFound();
  const key = sessionKey(agent, native);
  if (body.action === "interrupt" || body.action === "stop") await a.stop(native);
  else if (body.action === "mode") {
    const mode = parseMode(body.value);
    if (!mode) return NextResponse.json({ error: "Unknown permission mode." }, { status: 400 });
    modes.set(key, mode);
  } else if (body.action !== "model") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
