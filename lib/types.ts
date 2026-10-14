/* Shared wire types between the server (transcript parser, SDK runner) and the client. */

export type ToolResult = { text: string; isError: boolean; truncated: boolean };

export type Entry =
  | { kind: "user"; id: string; ts: string; text: string; images: number }
  | { kind: "text"; id: string; ts: string; msgId: string; text: string }
  | { kind: "thinking"; id: string; ts: string; msgId: string; text: string }
  | {
      kind: "tool";
      id: string;
      ts: string;
      msgId: string;
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { kind: "result"; id: string; ts: string; toolUseId: string; result: ToolResult }
  | { kind: "notice"; id: string; ts: string; tone: "info" | "warn"; text: string }
  /** token usage of one assistant message (the context it saw), for the context ring */
  | { kind: "usage"; id: string; ts: string; model: string; input: number; cacheRead: number; cacheWrite: number; output: number };

export type TerminalInfo = {
  pid: number;
  /** working folder of the terminal's claude, so a session can be followed before its transcript exists */
  cwd?: string;
  status: string;
  multiplexer: string | null;
  name: string | null;
};

/** Which coding agent a session belongs to. Plain session ids are Claude; others are "<agent>:<id>". */
export type AgentId = "claude" | "codex" | "opencode" | "cursor" | "devin" | "kimi";

export const AGENT_IDS: AgentId[] = ["claude", "codex", "opencode", "cursor", "devin", "kimi"];

export const AGENT_LABEL: Record<AgentId, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", cursor: "Cursor", devin: "Devin", kimi: "Kimi" };

/** An agent profile as the browser sees it (secrets masked). */
export type ProfileInfo = {
  id: string;
  label: string;
  agent: AgentId;
  bin: string;
  binPath: string | null;
  installed: boolean;
  args: string[];
  env: Record<string, string>;
  models: string[];
  defaultModel: string | null;
  fallback: string[];
  launchArgs: string[];
  hidden: boolean;
  notes: string;
  builtin: boolean;
  /** stored in the config file (a built-in only is when it's been edited) */
  custom: boolean;
};

/** A terminal the server keeps: a shell, or an agent launched from the web. */
export type ServerTerminal = {
  id: string;
  backing: "pty" | "tmux";
  kind: string;
  label: string;
  cwd: string;
  profile: string | null;
  session: string | null;
  createdAt: number;
  clients: number;
  pid: number | null;
  exited: { code: number } | null;
};

export type SessionSummary = {
  id: string;
  agent: AgentId;
  title: string;
  cwd: string;
  project: string;
  mtime: number;
  size: number;
  terminal: TerminalInfo | null;
  web: RunState | null;
};

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

export type PendingAsk =
  | {
      kind: "permission";
      requestId: string;
      toolName: string;
      title: string;
      description: string | null;
      input: Record<string, unknown>;
      canAlwaysAllow: boolean;
    }
  | { kind: "question"; requestId: string; questions: Question[] };

export type RunState = {
  status: "starting" | "running" | "idle" | "error" | "closed";
  model: string | null;
  permissionMode: PermissionMode;
  slashCommands: string[];
  pending: PendingAsk[];
  error: string | null;
  costUsd: number | null;
  /** set when the web run forked the transcript into a new session id */
  sessionId: string;
  /** Claude's suggested next message, after a turn ends */
  suggestion?: string | null;
};

export type StreamDelta = { msgId: string; index: number; kind: "text" | "thinking"; text: string };

export type ServerEvent =
  | { type: "history"; entries: Entry[]; cursor: number | null; terminal: TerminalInfo | null; run: RunState | null; title: string; cwd: string; permissionMode: PermissionMode | null; profile?: string | null }
  | { type: "entries"; entries: Entry[] }
  | { type: "delta"; delta: StreamDelta }
  | { type: "run"; run: RunState | null }
  | { type: "terminal"; terminal: TerminalInfo | null }
  /** the session got (or changed) its title after the stream opened */
  | { type: "title"; title: string }
  | { type: "redirect"; sessionId: string }
  | { type: "ping" };
