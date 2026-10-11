import type { ToolResult } from "@/lib/types";
import { pbBytes, pbNum, pbStr, pbTry } from "./cursor-store";

/* Cursor tool calls -> Claude-shaped {name, input}, so the UI's tool cards render them.
 * Three sources speak slightly different dialects:
 *  - stored JSON messages: model-facing names/args (Shell {command}, Read {path}, StrReplace {path, old_string, new_string}, Write {path, contents}, ...)
 *  - stream-json events:   protobuf JSON ({shellToolCall: {args: {command}, result: {success: {...}}}}, ...)
 *  - stored turn steps:    the same protobuf, binary (fallback when the JSON message is missing) */

export const CLIP = 8000;

export function clipResult(text: string, isError: boolean): ToolResult {
  return text.length > CLIP ? { text: text.slice(0, CLIP), isError, truncated: true } : { text, isError, truncated: false };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v: unknown) => (typeof v === "string" ? v : undefined);
const pick = (o: Obj, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};
const compact = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function todoStatus(v: unknown): string {
  const t = String(v ?? "").toLowerCase().replace(/^todo_status_/, "");
  if (t === "in_progress" || t === "inprogress" || t === "active") return "in_progress";
  if (t === "completed" || t === "done" || t === "cancelled" || t === "canceled") return "completed";
  return "pending";
}

const todos = (v: unknown) =>
  (Array.isArray(v) ? v : []).filter(isObj).map((t) => ({ content: String(t.content ?? t.title ?? ""), status: todoStatus(t.status) }));

/** Model-facing tool name + args (stored JSON messages; also `function` calls in the stream). */
export function mapModelTool(rawName: string, rawArgs: unknown): { name: string; input: Obj } {
  let args: Obj = isObj(rawArgs) ? rawArgs : {};
  if (typeof rawArgs === "string") {
    try {
      const j = JSON.parse(rawArgs);
      args = isObj(j) ? j : { value: rawArgs };
    } catch {
      args = { value: rawArgs };
    }
  }
  let name = rawName;
  /* dynamic tools (AwaitShell, ...) arrive wrapped */
  if (name === "CallDynamicTool" && typeof args.toolName === "string") {
    name = args.toolName;
    args = isObj(args.arguments) ? args.arguments : {};
  }
  const file = s(pick(args, "path", "file_path", "target_file", "filePath", "targetFile"));
  switch (name) {
    case "Shell":
    case "run_terminal_cmd":
    case "Bash":
      return { name: "Bash", input: compact({ command: s(pick(args, "command", "cmd")) ?? "", description: s(args.description), run_in_background: args.is_background === true ? true : undefined }) };
    case "Read":
    case "read_file":
      return { name: "Read", input: compact({ file_path: file ?? "", offset: typeof args.offset === "number" ? args.offset : undefined, limit: typeof args.limit === "number" ? args.limit : undefined }) };
    case "Write":
    case "write":
      return { name: "Write", input: { file_path: file ?? "", content: s(pick(args, "contents", "content", "file_text", "fileText", "code")) ?? "" } };
    case "StrReplace":
    case "search_replace":
    case "Edit":
    case "edit_file":
      if (args.old_string !== undefined || args.new_string !== undefined)
        return { name: "Edit", input: compact({ file_path: file ?? "", old_string: s(args.old_string) ?? "", new_string: s(args.new_string) ?? "", replace_all: args.replace_all === true ? true : undefined }) };
      return { name: "Edit", input: { file_path: file ?? "", old_string: "", new_string: s(pick(args, "code_edit", "streamContent", "contents", "content")) ?? "" } };
    case "MultiEdit":
      return { name: "MultiEdit", input: { file_path: file ?? "", edits: Array.isArray(args.edits) ? args.edits : [] } };
    case "Delete":
    case "delete_file":
      return { name: "Delete", input: { file_path: file ?? "" } };
    case "Glob":
    case "glob_file_search":
      return { name: "Glob", input: compact({ pattern: s(pick(args, "glob_pattern", "pattern", "globPattern")) ?? "", path: s(pick(args, "target_directory", "path", "targetDirectory")) }) };
    case "Grep":
    case "grep":
    case "grep_search":
      return {
        name: "Grep",
        input: compact({ pattern: s(pick(args, "pattern", "query")) ?? "", path: s(args.path), glob: s(pick(args, "glob", "include_pattern")), output_mode: s(args.output_mode), "-i": args.case_insensitive === true ? true : undefined }),
      };
    case "LS":
    case "list_dir":
      return { name: "LS", input: { path: s(pick(args, "target_directory", "path", "relative_workspace_path")) ?? "" } };
    case "TodoWrite":
    case "todo_write":
    case "UpdateTodos":
      return { name: "TodoWrite", input: { todos: todos(args.todos) } };
    case "WebSearch":
    case "web_search":
      return { name: "WebSearch", input: { query: s(pick(args, "search_term", "query", "searchTerm")) ?? "" } };
    case "WebFetch":
    case "Fetch":
      return { name: "WebFetch", input: { url: s(args.url) ?? "" } };
    case "Task":
      return { name: "Task", input: compact({ description: s(args.description) ?? "", prompt: s(args.prompt), subagent_type: s(args.subagent_type) }) };
    case "CreatePlan":
      return { name: "ExitPlanMode", input: { plan: s(pick(args, "plan", "overview", "content")) ?? JSON.stringify(args) } };
    default:
      return { name, input: args };
  }
}

/* ── stream-json (protobuf JSON) ───────────────────────────── */

const STREAM_NAMES: Record<string, string> = {
  shellToolCall: "Shell",
  readToolCall: "Read",
  writeToolCall: "Write",
  editToolCall: "Edit",
  deleteToolCall: "Delete",
  globToolCall: "Glob",
  grepToolCall: "Grep",
  lsToolCall: "LS",
  updateTodosToolCall: "TodoWrite",
  readTodosToolCall: "ReadTodos",
  webSearchToolCall: "WebSearch",
  webFetchToolCall: "WebFetch",
  fetchToolCall: "WebFetch",
  taskToolCall: "Task",
  createPlanToolCall: "CreatePlan",
  readLintsToolCall: "ReadLints",
  semSearchToolCall: "SemanticSearch",
  awaitToolCall: "AwaitShell",
};

/** Args in protobuf JSON use camelCase; rename to the model-facing keys mapModelTool knows. */
function streamArgs(kind: string, a: Obj): Obj {
  switch (kind) {
    case "writeToolCall":
      return { path: a.path, contents: a.fileText };
    case "editToolCall":
      return { path: a.path, code_edit: a.streamContent };
    case "globToolCall":
      return { glob_pattern: a.globPattern, target_directory: a.targetDirectory };
    case "grepToolCall":
      return { ...a, output_mode: a.outputMode, case_insensitive: a.caseInsensitive };
    case "webSearchToolCall":
      return { search_term: a.searchTerm };
    case "shellToolCall":
      return { command: a.command, description: a.description, is_background: a.isBackground };
    case "taskToolCall":
      return { description: a.description, prompt: a.prompt };
    default:
      return a;
  }
}

/** `tool_call` of a stream-json event -> {name, input, result?}. */
export function mapStreamTool(toolCall: unknown): { name: string; input: Obj; result: ToolResult | null } {
  const tc = isObj(toolCall) ? toolCall : {};
  if (isObj(tc.function)) {
    const f = tc.function;
    const { name, input } = mapModelTool(String(f.name ?? "tool"), f.arguments);
    return { name, input, result: isObj(f) && f.result !== undefined ? clipResult(stringify(f.result), false) : null };
  }
  const kind = Object.keys(tc).find((k) => k.endsWith("ToolCall") && isObj(tc[k]));
  if (!kind) return { name: "Tool", input: {}, result: null };
  const body = tc[kind] as Obj;
  const args = isObj(body.args) ? body.args : {};
  if (kind === "mcpToolCall") {
    const server = String(args.providerIdentifier ?? args.serverIdentifier ?? "mcp");
    const tool = String(args.toolName ?? args.name ?? "tool");
    return { name: `mcp__${server}__${tool}`, input: isObj(args.args) ? args.args : {}, result: body.result !== undefined ? streamResult(kind, body.result) : null };
  }
  const result = body.result !== undefined ? streamResult(kind, body.result) : null;
  /* a finished edit carries the whole file before/after: show it as a diff (or a write for a new file) */
  const ok = isObj(body.result) && isObj(body.result.success) ? body.result.success : null;
  if (kind === "editToolCall" && ok && typeof ok.afterFullFileContent === "string") {
    const file = s(args.path) ?? s(ok.path) ?? "";
    return typeof ok.beforeFullFileContent === "string"
      ? { name: "Edit", input: { file_path: file, old_string: ok.beforeFullFileContent, new_string: ok.afterFullFileContent }, result }
      : { name: "Write", input: { file_path: file, content: ok.afterFullFileContent }, result };
  }
  const modelName = STREAM_NAMES[kind] ?? kind.replace(/ToolCall$/, "").replace(/^./, (c) => c.toUpperCase());
  const { name, input } = mapModelTool(modelName, streamArgs(kind, args));
  return { name, input, result };
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

/** A protobuf-JSON result oneof ({success: ...} | {error: ...} | {rejected: ...}) -> display text. */
export function streamResult(kind: string, result: unknown): ToolResult {
  if (!isObj(result)) return clipResult(stringify(result), false);
  const key = Object.keys(result).find((k) => isObj(result[k]) || typeof result[k] === "string") ?? "";
  const v = result[key];
  const body: Obj = isObj(v) ? v : { message: v };
  const isError = key !== "success";
  if (kind === "shellToolCall" && (key === "success" || key === "failure")) {
    const out = s(body.interleavedOutput) ?? [s(body.stdout), s(body.stderr)].filter(Boolean).join("\n");
    const code = typeof body.exitCode === "number" ? body.exitCode : 0;
    return clipResult(code ? `${out}${out ? "\n" : ""}Exit code ${code}` : out, isError || code !== 0);
  }
  if (!isError) {
    if (kind === "readToolCall") return clipResult(s(body.content) ?? "", false);
    if (kind === "editToolCall" || kind === "writeToolCall") return clipResult(s(body.message) ?? s(body.diffString) ?? `Wrote ${s(body.path) ?? "file"}`, false);
    if (kind === "lsToolCall" || kind === "globToolCall") {
      const files = Array.isArray(body.files) ? body.files.join("\n") : null;
      if (files !== null) return clipResult(files, false);
    }
  }
  const msg = s(body.error) ?? s(body.reason) ?? s(body.message) ?? s(body.stderr);
  return clipResult(msg ?? stringify(body), isError);
}

/* ── stored JSON tool results ──────────────────────────────── */

export function jsonToolResult(part: Obj, message: Obj): ToolResult {
  let text = "";
  if (typeof part.result === "string") text = part.result;
  else if (Array.isArray(part.experimental_content))
    text = part.experimental_content
      .filter(isObj)
      .map((c) => (c.type === "text" ? String(c.text ?? "") : c.type === "image" ? "[Image]" : ""))
      .join("\n");
  else if (part.result !== undefined) text = stringify(part.result);
  const po = isObj(message.providerOptions) ? message.providerOptions : {};
  const hl = isObj(po.cursor) && isObj(po.cursor.highLevelToolCallResult) ? po.cursor.highLevelToolCallResult : null;
  let isError = hl?.isError === true;
  const out = hl && isObj(hl.output) ? hl.output : null;
  if (out && !("success" in out) && Object.keys(out).some((k) => ["error", "failure", "rejected", "timeout", "permissionDenied", "spawnError", "fileNotFound"].includes(k))) isError = true;
  if (out && isObj(out.success) && typeof out.success.exitCode === "number" && out.success.exitCode !== 0) isError = true;
  if (out && isObj(out.failure)) isError = true;
  /* shell: the raw output reads better than the "Exit code: 0\n\nCommand output: ```...```" text the model saw */
  const sh = out ? (isObj(out.success) ? out.success : isObj(out.failure) ? out.failure : null) : null;
  if (sh && typeof sh.command === "string" && (typeof sh.interleavedOutput === "string" || typeof sh.stdout === "string")) {
    const raw = s(sh.interleavedOutput) ?? [s(sh.stdout), s(sh.stderr)].filter(Boolean).join("\n");
    const code = typeof sh.exitCode === "number" ? sh.exitCode : 0;
    text = code ? `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}Exit code ${code}` : raw;
  }
  return clipResult(text, isError);
}

/* ── binary ToolCall fallback (no JSON message for this call) ─ */

const PROTO_KINDS: Record<number, string> = {
  1: "shellToolCall",
  3: "deleteToolCall",
  4: "globToolCall",
  5: "grepToolCall",
  8: "readToolCall",
  9: "updateTodosToolCall",
  12: "editToolCall",
  13: "lsToolCall",
  15: "mcpToolCall",
  18: "webSearchToolCall",
  19: "taskToolCall",
  24: "fetchToolCall",
  37: "webFetchToolCall",
  42: "awaitToolCall",
};

export function mapProtoTool(field: number, bytes: Uint8Array): { name: string; input: Obj; result: ToolResult | null } {
  const kind = PROTO_KINDS[field];
  const body = pbTry(bytes);
  const a = pbTry(pbBytes(body, 1));
  const resBytes = pbBytes(body, 2);
  let args: Obj = {};
  switch (kind) {
    case "shellToolCall":
      args = { command: pbStr(a, 1), description: pbStr(a, 15) ?? pbStr(body, 3) };
      break;
    case "deleteToolCall":
    case "readToolCall":
    case "lsToolCall":
      args = { path: pbStr(a, 1) };
      break;
    case "editToolCall":
      args = { path: pbStr(a, 1), streamContent: pbStr(a, 6) };
      break;
    case "globToolCall":
      args = { targetDirectory: pbStr(a, 1), globPattern: pbStr(a, 2) };
      break;
    case "grepToolCall":
      args = { pattern: pbStr(a, 1), path: pbStr(a, 2), glob: pbStr(a, 3) };
      break;
    case "webSearchToolCall":
      args = { searchTerm: pbStr(a, 1) };
      break;
    case "fetchToolCall":
    case "webFetchToolCall":
      args = { url: pbStr(a, 1) };
      break;
    case "taskToolCall":
      args = { description: pbStr(a, 1), prompt: pbStr(a, 2) };
      break;
    case "mcpToolCall":
      args = { toolName: pbStr(a, 5) ?? pbStr(a, 1), providerIdentifier: pbStr(a, 4) };
      break;
  }
  const mapped = kind ? mapStreamTool({ [kind]: { args: compact(args) } }) : { name: `Tool ${field}`, input: {}, result: null };
  let result: ToolResult | null = null;
  if (resBytes) {
    const r = pbTry(resBytes);
    if (kind === "shellToolCall") {
      const ok = pbBytes(r, 1);
      const bad = pbBytes(r, 2);
      const f = pbTry(ok ?? bad);
      const out = [pbStr(f, 5), pbStr(f, 6)].filter(Boolean).join("\n");
      const code = pbNum(f, 3) ?? 0;
      result = ok || bad ? clipResult(code ? `${out}\nExit code ${code}` : out, !!bad || code !== 0) : clipResult("", r[0]?.n !== 1);
    } else {
      /* oneof result: field 1 is success in every Cursor tool result */
      const first = r[0];
      const f = first && first.v instanceof Uint8Array ? pbTry(first.v) : [];
      const text = first?.n === 1 ? "" : (f.map((x) => (x.v instanceof Uint8Array ? Buffer.from(x.v).toString("utf8") : "")).find((t) => /^[\P{Cc}\n\t]+$/u.test(t)) ?? "Failed");
      result = clipResult(text, first?.n !== 1);
    }
  }
  return { name: mapped.name, input: mapped.input, result };
}
