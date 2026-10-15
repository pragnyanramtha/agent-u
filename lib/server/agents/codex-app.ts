import type { PermissionMode } from "@/lib/types";
import { killGroup, liveStream, startTurn, type Run } from "./cli-run";
import { errorText } from "./codex-parse";

/* One web-driven Codex turn over `codex app-server` (JSON-RPC 2.0, one JSON
 * object per line on stdio). Unlike `codex exec --json`, which only reports
 * finished items, the app server streams the reply as it is written:
 *
 *   -> initialize {clientInfo}            <- result
 *   -> initialized (notification)
 *   -> thread/start {cwd, sandbox, approvalPolicy, model} | thread/resume {threadId, ...}
 *   -> turn/start {threadId, input: [{type: "text", text}]}
 *   <- item/agentMessage/delta {itemId, delta}            live text
 *   <- item/reasoning/summaryTextDelta {itemId, delta, summaryIndex}, item/reasoning/textDelta   live thinking
 *   <- error {error, willRetry}, turn/completed {turn: {status, error}}
 *
 * The thread is persisted to the usual rollout file, which stays the source of
 * truth for history. Stdin is closed once the turn completes, which ends the
 * process. */

type Msg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };

export type AppTurnOptions = {
  key: string;
  bin: string;
  cwd: string;
  text: string;
  model?: string;
  mode: PermissionMode;
  /** resume this thread; omitted starts a new one */
  threadId?: string;
  /** Responses API items put into a new thread's history before the first turn (a conversation moved from another agent) */
  inject?: unknown[];
  /** the thread id, as soon as the app server reports it (before the model answers) */
  onThread?: (id: string) => void;
};

/* exec can't show approval prompts and neither can this: never ask, the sandbox is the only guard */
function threadSettings(mode: PermissionMode, model?: string) {
  const sandbox = mode === "bypassPermissions" ? "danger-full-access" : mode === "plan" ? "read-only" : "workspace-write";
  return { approvalPolicy: "never", sandbox, ...(model ? { model } : {}) };
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function appServerTurn(o: AppTurnOptions): Run {
  let nextId = 0;
  const replies = new Map<number, (m: Msg) => void>();
  let failure: string | null = null;
  let threadId: string | null = o.threadId ?? null;
  let done = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  /* reasoning items that streamed a summary (raw reasoning text for them is skipped), and their last summary index */
  const summaries = new Map<string, number>();

  const run = startTurn(o.key, { cmd: o.bin, args: ["app-server"], cwd: o.cwd, keepStdin: true }, (line) => onLine(line));
  const live = liveStream(run);

  function write(m: object) {
    const stdin = run.child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  }
  function request(method: string, params: unknown, then: (m: Msg) => void) {
    const id = ++nextId;
    replies.set(id, then);
    write({ id, method, params });
  }
  /** ends the turn: closing stdin makes the app server exit; a stuck one is terminated */
  function finish(err?: string | null) {
    if (err && !failure) failure = err;
    if (done) return;
    done = true;
    run.child.stdin?.end();
    killTimer = setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) killGroup(run.child);
    }, 5000);
  }
  const fail = (m: Msg, what: string) => finish(errorText(m.error?.message || `${what} failed`));

  function onLine(line: string) {
    if (!line.startsWith("{")) return;
    let m: Msg;
    try {
      m = JSON.parse(line) as Msg;
    } catch {
      return;
    }
    if (m.id !== undefined && m.method === undefined) {
      const then = replies.get(Number(m.id));
      replies.delete(Number(m.id));
      then?.(m);
    } else if (m.id !== undefined && m.method) answer(m);
    else if (m.method) notify(m.method, obj(m.params));
  }

  /** Server-initiated requests. With approvalPolicy "never" approvals shouldn't come; decline any that do. */
  function answer(m: Msg) {
    const decline =
      m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval"
        ? { decision: "decline" }
        : m.method === "execCommandApproval" || m.method === "applyPatchApproval"
          ? { decision: { denied: { rejection: "Approvals can't be answered from the web UI." } } }
          : null;
    if (decline) write({ id: m.id, result: decline });
    else write({ id: m.id, error: { code: -32601, message: `${m.method} isn't supported by agent-u` } });
  }

  function notify(method: string, p: Record<string, unknown>) {
    /* subagents run on threads of their own; only the session's thread counts */
    if (typeof p.threadId === "string" && threadId && p.threadId !== threadId) return;
    const item = str(p.itemId);
    switch (method) {
      case "item/agentMessage/delta":
        live.push(item, "text", str(p.delta));
        break;
      case "item/reasoning/summaryTextDelta": {
        const index = Number(p.summaryIndex) || 0;
        const prev = summaries.get(item);
        summaries.set(item, index);
        live.push(item, "thinking", `${prev !== undefined && prev !== index ? "\n\n" : ""}${str(p.delta)}`);
        break;
      }
      case "item/reasoning/textDelta":
        if (!summaries.has(item)) live.push(`${item}:raw`, "thinking", str(p.delta));
        break;
      case "error":
        if (p.willRetry !== true) failure = errorText(str(obj(p.error).message) || "Codex reported an error");
        break;
      case "turn/completed": {
        const turn = obj(p.turn);
        finish(turn.status === "failed" ? errorText(str(obj(turn.error).message) || failure || "The Codex turn failed") : null);
        break;
      }
    }
  }

  run.child.on("exit", () => {
    clearTimeout(killTimer);
    if (!failure) return;
    /* cli-run's own exit handler already ran (registered first); replace its outcome with the turn's error */
    run.state = { ...run.state, status: "error", error: failure };
    run.listeners.forEach((fn) => fn(run.state));
  });

  request("initialize", { clientInfo: { name: "agent-u", title: "agent-u", version: "1.0.0" }, capabilities: null }, (m) => {
    if (m.error) return fail(m, "Starting the Codex app server");
    write({ method: "initialized" });
    const onThreadReady = (r: Msg) => {
      if (r.error) return fail(r, o.threadId ? "Resuming the Codex session" : "Starting a Codex session");
      threadId = str(obj(obj(r.result).thread).id) || threadId;
      if (!threadId) return finish("Codex didn't report a session id.");
      o.onThread?.(threadId);
      const turn = () =>
        request("turn/start", { threadId, input: [{ type: "text", text: o.text, text_elements: [] }] }, (t) => {
          if (t.error) fail(t, "Starting the turn");
        });
      if (o.inject?.length && !o.threadId) request("thread/inject_items", { threadId, items: o.inject }, (r) => (r.error ? fail(r, "Importing the earlier conversation") : turn()));
      else turn();
    };
    if (o.threadId) request("thread/resume", { threadId: o.threadId, excludeTurns: true, ...threadSettings(o.mode, o.model) }, onThreadReady);
    else request("thread/start", { cwd: o.cwd, ...threadSettings(o.mode, o.model) }, onThreadReady);
  });

  return run;
}
