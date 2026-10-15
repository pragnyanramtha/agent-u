import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import type { AgentId, PermissionMode, ServerEvent } from "@/lib/types";
import { parseMode, str } from "../http";
import { InputRefused, inputTarget, typeIntoTerminal } from "../input";
import { terminalOf, toRunState } from "./bridge";
import { onDelta, onTurn } from "./cli-run";
import { adapterFor, sessionKey } from "./index";
import { handoffTitle } from "@/lib/handoff-text";
import { guardTurn, onSessionEvent, postNotice, postToSession, sameStore } from "../fallback";
import { pickProfile, setSessionProfile, withProfile } from "../profiles";

/* Route handlers for non-Claude sessions (ids "<agent>:<nativeId>").
 * Same wire shapes as the Claude routes, so the client doesn't care which agent it is. */

const notFound = () => NextResponse.json({ error: "Session not found" }, { status: 404 });
const modes = new Map<string, PermissionMode>();
/** their print modes can't ask for approval on the web, so unattended turns may act (the UI shows Bypass) */
const DEFAULT_MODE: PermissionMode = "bypassPermissions";

/* Messages sent while a web-driven turn runs wait here and go out, in order, when it ends
 * (or is stopped): the CLIs take one prompt per turn. Keyed by session key; the item id is
 * the client's message id, so the client can take one back. */
type Queued = { id: string; text: string; model?: string; mode: PermissionMode; profile: unknown };
const g = globalThis as { __agentuQueues?: Map<string, Queued[]>; __agentuDrains?: Map<string, () => void> };
const queues: Map<string, Queued[]> = (g.__agentuQueues ??= new Map());
const drains: Map<string, () => void> = (g.__agentuDrains ??= new Map());

const queueEvent = (key: string): ServerEvent => ({ type: "queue", items: (queues.get(key) ?? []).map(({ id, text }) => ({ id, text })) });
const announce = (key: string) => postToSession(key, queueEvent(key));

/** sessions with a send in flight (the CLI may not report "running" until its process is up) */
const sending: Set<string> = ((g as { __agentuSending?: Set<string> }).__agentuSending ??= new Set());
const busy = (a: { runState(n: string): { status: string } | null }, native: string, key: string) => sending.has(key) || a.runState(native)?.status === "running";

function enqueue(agent: AgentId, native: string, item: Queued) {
  const key = sessionKey(agent, native);
  const list = queues.get(key) ?? [];
  if (!list.some((q) => q.id === item.id)) list.push(item);
  queues.set(key, list);
  announce(key);
  if (!drains.has(key)) drains.set(key, onTurn(key, (s) => s.status !== "running" && void drain(agent, native)));
}

function forget(key: string) {
  if (queues.get(key)?.length) return;
  queues.delete(key);
  drains.get(key)?.();
  drains.delete(key);
}

/** Sends the next queued message once nothing runs; one that fails to start is reported and the next one tried. */
async function drain(agent: AgentId, native: string) {
  const key = sessionKey(agent, native);
  if (sending.has(key)) return;
  sending.add(key);
  try {
    const a = await adapterFor(agent);
    if (!a || a.runState(native)?.status === "running") return;
    for (;;) {
      const next = queues.get(key)?.shift();
      announce(key);
      if (!next) break;
      const res = await sendNow(agent, native, next.text, next);
      if (res.ok) break;
      postNotice(key, `Couldn't send a queued message ("${next.text.slice(0, 60)}"): ${res.error}`, "warn");
    }
  } finally {
    sending.delete(key);
    forget(key);
    void settle(agent, native);
  }
}

/* a turn that ended while a send was in flight left its end-of-turn drain unanswered */
async function settle(agent: AgentId, native: string) {
  const key = sessionKey(agent, native);
  if (!queues.get(key)?.length) return;
  const a = await adapterFor(agent);
  if (a && !busy(a, native, key)) void drain(agent, native);
}

export function unqueue(agent: AgentId, native: string, id: string) {
  const key = sessionKey(agent, native);
  queues.set(key, (queues.get(key) ?? []).filter((q) => q.id !== id));
  forget(key);
  announce(key);
}

/** Puts one queued message first and stops the running turn, so it goes out next. */
async function sendQueuedNow(agent: AgentId, native: string, id: string) {
  const key = sessionKey(agent, native);
  const list = queues.get(key) ?? [];
  const i = list.findIndex((q) => q.id === id);
  if (i > 0) list.unshift(...list.splice(i, 1));
  announce(key);
  const a = await adapterFor(agent);
  if (!a) return;
  if (a.runState(native)?.status === "running") await a.stop(native);
  else void drain(agent, native);
}

async function sendNow(agent: AgentId, native: string, text: string, o: { model?: string; mode: PermissionMode; profile: unknown }): Promise<{ ok: true } | { ok: false; error: string; status: number; code?: string }> {
  const a = await adapterFor(agent);
  if (!a) return { ok: false, error: "Session not found", status: 404 };
  const key = sessionKey(agent, native);
  const before = pickProfile(agent, null, key);
  const profile = pickProfile(agent, o.profile, key);
  if (!sameStore(before, profile)) return { ok: false, error: `${profile.label} keeps its sessions elsewhere. Use "Continue in" to move this session there.`, status: 409, code: "other_store" };
  try {
    await withProfile(profile, () => a.send(native, text, { model: o.model || profile.defaultModel || profile.models?.[0] || undefined, mode: o.mode }));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), status: 502 };
  }
  setSessionProfile(key, profile.id);
  guardTurn({ key, text, mode: o.mode, model: o.model, profile });
  return { ok: true };
}

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
    run: toRunState(key, a.runState(native), modes.get(key) ?? DEFAULT_MODE, session?.model ?? null),
    title: handoffTitle(session?.title ?? "") || `New ${a.label} session`,
    cwd: session?.cwd ?? "",
    permissionMode: modes.get(key) ?? null,
    profile: pickProfile(agent, null, key).id,
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
      const runOf = () => toRunState(key, a.runState(native), modes.get(key) ?? DEFAULT_MODE, session?.model ?? null);
      send({ type: "history", entries: [], cursor: null, terminal, run: runOf(), title: handoffTitle(session?.title ?? "") || `New ${a.label} session`, cwd: session?.cwd ?? "", permissionMode: modes.get(key) ?? null, profile: pickProfile(agent, null, key).id });
      /* always: a queue lost to a restart must clear what the client still shows */
      send(queueEvent(key));
      cleanups.push(onSessionEvent(key, (e) => send(e)));
      cleanups.push(a.watch(native, start, (entries, end) => entries.length && send({ type: "entries", entries }, end)));
      cleanups.push(onTurn(key, () => send({ type: "run", run: runOf() })));
      /* live text of a web-driven turn; a running turn replays its text so far right after the history event */
      cleanups.push(onDelta(key, (delta) => send({ type: "delta", delta })));
      let last = JSON.stringify(terminal);
      let title = handoffTitle(session?.title ?? "");
      const tick = setInterval(async () => {
        const [t, s] = await Promise.all([terminalOf(a, native).catch(() => null), a.get(native).catch(() => null)]);
        const k = JSON.stringify(t);
        if (k !== last) {
          last = k;
          send({ type: "terminal", terminal: t });
        }
        /* new sessions get their title from the agent a little after the first turn */
        if (s?.title && handoffTitle(s.title) !== title) {
          title = handoffTitle(s.title);
          send({ type: "title", title });
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
  const mode = parseMode(body.permissionMode) ?? modes.get(key) ?? DEFAULT_MODE;
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
  const model = str(body.model) || undefined;
  if (busy(a, native, key) || queues.get(key)?.length) {
    const before = pickProfile(agent, null, key);
    if (!sameStore(before, pickProfile(agent, body.profile, key))) {
      return NextResponse.json({ error: `That profile keeps its sessions elsewhere. Use "Continue in" to move this session there.`, code: "other_store" }, { status: 409 });
    }
    enqueue(agent, native, { id: str(body.clientId) || `q${Date.now().toString(36)}`, text, model, mode, profile: body.profile });
    /* the turn may have ended while this was queued */
    void settle(agent, native);
    return NextResponse.json({ id: key, via: "queued" });
  }
  sending.add(key);
  const res = await sendNow(agent, native, text, { model, mode, profile: body.profile }).finally(() => sending.delete(key));
  void settle(agent, native);
  if (!res.ok) return NextResponse.json({ error: res.error, code: res.code }, { status: res.status });
  return NextResponse.json({ id: key, via: "web" });
}

export async function agentStart(agent: AgentId, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return NextResponse.json({ error: "Unknown agent." }, { status: 400 });
  const chosen = pickProfile(agent, body.profile, null);
  if (!(chosen.bin ? chosen.binPath : await a.binary())) return NextResponse.json({ error: `${chosen.label} isn't installed on the server.` }, { status: 400 });
  const text = str(body.text)?.trim();
  const cwd = str(body.cwd)?.trim();
  if (!text) return NextResponse.json({ error: "Write a first message to start the session." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: `No folder at ${cwd || "(empty)"} on the server.` }, { status: 400 });
  }
  const mode = parseMode(body.permissionMode) ?? DEFAULT_MODE;
  const profile = chosen;
  const model = str(body.model) || profile.defaultModel || profile.models?.[0] || undefined;
  try {
    const { id } = await Promise.race([
      withProfile(profile, () => a.start({ cwd, text, model, mode })),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${a.label} didn't start within 90 seconds.`)), 90_000)),
    ]);
    const key = sessionKey(agent, id);
    modes.set(key, mode);
    setSessionProfile(key, profile.id);
    guardTurn({ key, text, mode, model, profile });
    return NextResponse.json({ id: key });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

export async function agentControl(agent: AgentId, native: string, body: Record<string, unknown>) {
  const a = await adapterFor(agent);
  if (!a) return notFound();
  const key = sessionKey(agent, native);
  if (body.action === "interrupt" || body.action === "stop") await a.stop(native);
  else if (body.action === "unqueue") unqueue(agent, native, str(body.value) ?? "");
  else if (body.action === "sendQueued") await sendQueuedNow(agent, native, str(body.value) ?? "");
  else if (body.action === "mode") {
    const mode = parseMode(body.value);
    if (!mode) return NextResponse.json({ error: "Unknown permission mode." }, { status: 400 });
    modes.set(key, mode);
  } else if (body.action !== "model") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  return NextResponse.json({ ok: true });
}
