import type { Entry } from "@/lib/types";
import { toolId } from "./cursor-entries";
import { mapStreamTool } from "./cursor-tools";

/* `cursor-agent -p --output-format stream-json` events -> Entry[].
 *
 * store.db is the source of truth for history; this mapping covers web-driven turns whose
 * stream we captured (~/.local/share/claude-ui/cursor/<chatId>.jsonl), used when the store
 * can't be read (missing, or a future format this adapter doesn't understand).
 *
 * Events (cursor-agent 2026.x): system/init {session_id, model, cwd}; user {message.content[]};
 * thinking delta/completed; assistant {message.content[{type:"text"}]} (one per segment between
 * tool calls without --stream-partial-output); tool_call started/completed {call_id, tool_call};
 * result {usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}. Captured lines
 * carry our own `_ts` (epoch ms) and `_n` (line number within the capture, for stable ids). */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const textOf = (message: unknown) =>
  isObj(message) && Array.isArray(message.content)
    ? message.content
        .filter(isObj)
        .map((c) => (c.type === "text" ? String(c.text ?? "") : ""))
        .join("")
    : "";

/** Stateful mapper over one capture (feed events in order). */
export function streamMapper(prefix = "s") {
  let model = "cursor";
  let thinking = "";
  let thinkingId = "";
  let turn = "";
  const seenTools = new Set<string>();
  return (ev: unknown, n: number): Entry[] => {
    if (!isObj(ev)) return [];
    const ts = new Date(typeof ev._ts === "number" ? ev._ts : typeof ev.timestamp_ms === "number" ? ev.timestamp_ms : Date.now()).toISOString();
    const id = `${prefix}${n}`;
    const out: Entry[] = [];
    const flushThinking = () => {
      if (thinking.trim()) out.push({ kind: "thinking", id: thinkingId, ts, msgId: turn || id, text: thinking.trim() });
      thinking = "";
    };
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init" && typeof ev.model === "string") model = ev.model;
        break;
      case "user": {
        flushThinking();
        turn = id;
        const text = textOf(ev.message).trim();
        if (text) out.push({ kind: "user", id, ts, text, images: 0 });
        break;
      }
      case "thinking":
        if (ev.subtype === "delta" && typeof ev.text === "string") {
          if (!thinking) thinkingId = id;
          thinking += ev.text;
        } else if (ev.subtype === "completed") flushThinking();
        break;
      case "assistant": {
        flushThinking();
        const text = textOf(ev.message);
        if (text.trim()) out.push({ kind: "text", id, ts, msgId: turn || id, text });
        break;
      }
      case "tool_call": {
        flushThinking();
        const callId = String(ev.call_id ?? (isObj(ev.tool_call) ? ev.tool_call.toolCallId : "") ?? id);
        const tid = toolId(callId);
        const mapped = mapStreamTool(ev.tool_call);
        /* edits are shown once finished, when the event has the file before and after */
        const isEdit = isObj(ev.tool_call) && isObj(ev.tool_call.editToolCall);
        if (isEdit && ev.subtype !== "completed") break;
        if (!seenTools.has(tid)) {
          seenTools.add(tid);
          out.push({ kind: "tool", id: `${id}.t`, ts, msgId: turn || id, toolUseId: tid, name: mapped.name, input: mapped.input });
        }
        if (ev.subtype === "completed") out.push({ kind: "result", id: `${id}.r`, ts, toolUseId: tid, result: mapped.result ?? { text: "", isError: false, truncated: false } });
        break;
      }
      case "result": {
        flushThinking();
        const u = isObj(ev.usage) ? ev.usage : null;
        if (u) {
          const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
          out.push({ kind: "usage", id, ts, model, input: num("inputTokens"), cacheRead: num("cacheReadTokens"), cacheWrite: num("cacheWriteTokens"), output: num("outputTokens") });
        }
        if (ev.is_error === true) out.push({ kind: "notice", id: `${id}.e`, ts, tone: "warn", text: String(ev.result || "Cursor reported an error.") });
        break;
      }
      case "error":
        out.push({ kind: "notice", id, ts, tone: "warn", text: String(ev.message ?? ev.error ?? "Cursor reported an error.") });
        break;
    }
    return out;
  };
}

/** Maps a whole capture (JSONL text). */
export function streamEntries(jsonl: string, prefix = "s"): Entry[] {
  const map = streamMapper(prefix);
  const out: Entry[] = [];
  jsonl.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const n = isObj(ev) && typeof ev._n === "number" ? ev._n : i;
    out.push(...map(ev, n));
  });
  return out;
}
