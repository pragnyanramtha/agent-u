import type { Entry } from "@/lib/types";
import type { AiMessage, AiPart, StoreChat } from "./cursor-store";
import { clipResult, jsonToolResult, mapModelTool, mapProtoTool } from "./cursor-tools";

/* store.db -> Entry[]. The turn structure (protobuf) is the timeline: user text, thinking,
 * assistant text and tool calls in order, with timestamps. Tool names/args/results come from
 * the JSON messages (keyed by tool call id), which carry the model-facing args and the exact
 * result text the model saw. Chats without turns fall back to the JSON messages alone. */

type Obj = Record<string, unknown>;

const iso = (ms: number) => new Date(ms).toISOString();
/** UI keys tool results by this id; Cursor's ids can contain newlines. */
export const toolId = (raw: string) => raw.replace(/\s+/g, "~");

/* context blocks Cursor injects into user messages (same list as its own transcript writer) */
const CONTEXT_TAGS = [
  "user_info", "project_layout", "rules", "always_applied_workspace_rules", "agent_requestable_workspace_rules", "user_rules",
  "agent_skills", "available_skills", "manually_attached_skills", "cloud_instructions", "cloud_task_instructions",
  "open_and_recently_viewed_files", "system_reminder", "system-reminder", "instructions_update", "mcp_instructions",
  "mcp_file_system", "mcp_file_system_servers", "git_status", "agent_transcripts", "cursor_rules_context", "attached_files",
  "system_notification", "task_notification", "agent_notification", "timestamp",
];

export function cleanUserText(text: string): string {
  const q = [...text.matchAll(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/g)].map((m) => m[1]);
  if (q.length) return q.join("\n\n").trim();
  let r = text;
  for (const t of CONTEXT_TAGS) r = r.replace(new RegExp(`<${t}(?:\\s[^>]*)?>[\\s\\S]*?</${t}>`, "gi"), "");
  return r.replace(/\n{3,}/g, "\n\n").trim();
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "<timestamp>Sunday, Oct 11, 2026, 9:42 PM (UTC+5:30)</timestamp>" -> epoch ms */
export function parseCursorTimestamp(text: string): number | null {
  const m = /<timestamp>[^<]*?([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}) ?(AM|PM)?(?: \(UTC([+-])(\d{1,2})(?::(\d{2}))?\))?/i.exec(text);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  let h = Number(m[4]) % 12;
  if (m[6]?.toUpperCase() === "PM") h += 12;
  if (!m[6]) h = Number(m[4]);
  const off = m[7] ? (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9] ?? 0)) : 0;
  return Date.UTC(Number(m[3]), mon, Number(m[2]), h, Number(m[5])) - off * 60_000;
}

const partsOf = (m: AiMessage): AiPart[] => (Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : []);
const stripThink = (t: string) => t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();

function indexTools(messages: AiMessage[]) {
  const calls = new Map<string, { name: string; args: unknown }>();
  const results = new Map<string, { part: AiPart; message: AiMessage }>();
  for (const m of messages)
    for (const p of partsOf(m)) {
      if (p.type === "tool-call" && p.toolCallId) calls.set(p.toolCallId, { name: String(p.toolName ?? "tool"), args: p.args });
      else if (p.type === "tool-result" && p.toolCallId) results.set(p.toolCallId, { part: p, message: m });
    }
  return { calls, results };
}

export type StoreEntryOptions = {
  /** epoch ms used when nothing carries a timestamp */
  fallbackTs: number;
  /** drop a trailing text/thinking step of the last turn (it may still be streaming in) */
  holdTail?: boolean;
  model?: string | null;
};

export function storeEntries(chat: StoreChat, opts: StoreEntryOptions): Entry[] {
  return chat.turns.length ? fromTurns(chat, opts) : fromMessages(chat, opts);
}

function fromTurns(chat: StoreChat, opts: StoreEntryOptions): Entry[] {
  const { calls, results } = indexTools(chat.messages);
  const out: Entry[] = [];
  let last = opts.fallbackTs;
  let lastKey = "";
  let model = opts.model ?? null;
  chat.turns.forEach((turn, i) => {
    if (turn.kind === "shell") {
      const key = `s${i}`;
      const ts = iso(last);
      const tid = toolId(`shell-${key}`);
      out.push({ kind: "tool", id: key, ts, msgId: key, toolUseId: tid, name: "Bash", input: { command: turn.command } });
      const text = [turn.stdout, turn.stderr].filter(Boolean).join("\n");
      out.push({ kind: "result", id: `${key}.r`, ts, toolUseId: tid, result: clipResult(text, (turn.exitCode ?? 0) !== 0) });
      lastKey = key;
      return;
    }
    const key = turn.userId ? `u-${turn.userId}` : `t${i}`;
    lastKey = key;
    if (turn.model) model = turn.model;
    if (turn.ts) last = turn.ts;
    const userText = cleanUserText(turn.userText);
    if (userText) out.push({ kind: "user", id: key, ts: iso(last), text: userText, images: 0 });
    let steps = turn.steps;
    if (opts.holdTail && i === chat.turns.length - 1) {
      const tail = steps[steps.length - 1];
      if (tail && (tail.kind === "text" || tail.kind === "thinking")) steps = steps.slice(0, -1);
    }
    steps.forEach((step, j) => {
      const id = `${key}.${j}`;
      if (step.kind !== "unknown" && step.ts) last = Math.max(last, step.ts);
      const ts = iso(last);
      if (step.kind === "text") {
        const text = stripThink(step.text);
        if (text) out.push({ kind: "text", id, ts, msgId: key, text });
      } else if (step.kind === "thinking") {
        if (step.text.trim()) out.push({ kind: "thinking", id, ts, msgId: key, text: step.text.trim() });
      } else if (step.kind === "tool") {
        const json = step.callId ? calls.get(step.callId) : undefined;
        const proto = mapProtoTool(step.field, step.tool);
        const { name, input } = json ? mapModelTool(json.name, json.args) : proto;
        const tid = toolId(step.callId || id);
        out.push({ kind: "tool", id, ts, msgId: key, toolUseId: tid, name, input });
        const r = step.callId ? results.get(step.callId) : undefined;
        const result = r ? jsonToolResult(r.part as Obj, r.message as unknown as Obj) : step.done ? proto.result ?? clipResult("", false) : null;
        if (result) out.push({ kind: "result", id: `${id}.r`, ts, toolUseId: tid, result });
      }
    });
  });
  if (chat.tokens && chat.tokens.used > 0 && lastKey)
    out.push({ kind: "usage", id: `${lastKey}.usage.${chat.tokens.used}`, ts: iso(last), model: model ?? "cursor", input: chat.tokens.used, cacheRead: 0, cacheWrite: 0, output: 0 });
  return out;
}

function fromMessages(chat: StoreChat, opts: StoreEntryOptions): Entry[] {
  const out: Entry[] = [];
  let last = opts.fallbackTs;
  let model = opts.model ?? null;
  let msgKey = "m";
  chat.messages.forEach((m, i) => {
    const key = `m${i}`;
    if (m.role === "user") {
      const raw = partsOf(m).map((p) => (p.type === "text" ? String(p.text ?? "") : "")).join("\n");
      const ts = parseCursorTimestamp(raw);
      if (ts) last = ts;
      const text = cleanUserText(raw);
      if (text) out.push({ kind: "user", id: key, ts: iso(last), text, images: partsOf(m).filter((p) => p.type === "image").length });
      msgKey = key;
      return;
    }
    if (m.role === "assistant") {
      partsOf(m).forEach((p, j) => {
        const id = `${key}.${j}`;
        const ts = iso(last);
        if (p.type === "text" && p.text) {
          const text = stripThink(p.text);
          if (text) out.push({ kind: "text", id, ts, msgId: msgKey, text });
        } else if (p.type === "reasoning" && typeof p.text === "string" && p.text.trim()) {
          out.push({ kind: "thinking", id, ts, msgId: msgKey, text: p.text.trim() });
          const pm = (p.providerOptions as { cursor?: { modelName?: string } } | undefined)?.cursor?.modelName;
          if (pm) model = pm;
        } else if (p.type === "tool-call") {
          const { name, input } = mapModelTool(String(p.toolName ?? "tool"), p.args);
          out.push({ kind: "tool", id, ts, msgId: msgKey, toolUseId: toolId(p.toolCallId ?? id), name, input });
        }
      });
      return;
    }
    if (m.role === "tool") {
      partsOf(m).forEach((p, j) => {
        if (p.type !== "tool-result" || !p.toolCallId) return;
        out.push({ kind: "result", id: `${key}.${j}`, ts: iso(last), toolUseId: toolId(p.toolCallId), result: jsonToolResult(p as Obj, m as unknown as Obj) });
      });
    }
  });
  const tail = out[out.length - 1];
  if (opts.holdTail && tail && (tail.kind === "text" || tail.kind === "thinking")) out.pop();
  if (chat.tokens && chat.tokens.used > 0 && out.length)
    out.push({ kind: "usage", id: `m${chat.messages.length}.usage.${chat.tokens.used}`, ts: iso(last), model: model ?? "cursor", input: chat.tokens.used, cacheRead: 0, cacheWrite: 0, output: 0 });
  return out;
}
