export type ToolIcon = "read" | "edit" | "run" | "search" | "web" | "agent" | "plan" | "ask" | "tool";

export type ToolSummary = { verb: string; chip: string; mono: boolean; icon: ToolIcon };

const base = (p: unknown) => (typeof p === "string" ? p.split("/").filter(Boolean).pop() ?? p : "");
const str = (v: unknown) => (typeof v === "string" ? v : "");
const firstLine = (s: string) => s.split("\n")[0];

/** One-line label + chip for a tool call, in the same grammar as Beautiful UI's ToolChips rows. */
export function summarizeTool(name: string, input: Record<string, unknown>): ToolSummary {
  switch (name) {
    case "Read":
      return { verb: "Read", chip: base(input.file_path), mono: true, icon: "read" };
    case "Write":
      return { verb: `Wrote ${str(input.content).split("\n").length} lines`, chip: base(input.file_path), mono: true, icon: "edit" };
    case "Edit":
    case "MultiEdit":
      return { verb: "Edited", chip: base(input.file_path), mono: true, icon: "edit" };
    case "NotebookEdit":
      return { verb: "Edited notebook", chip: base(input.notebook_path), mono: true, icon: "edit" };
    case "Bash":
      return { verb: str(input.description) ? firstLine(str(input.description)) : "Ran", chip: firstLine(str(input.command)), mono: true, icon: "run" };
    case "BashOutput":
    case "TaskOutput":
      return { verb: "Checked output", chip: str(input.bash_id) || str(input.task_id), mono: true, icon: "run" };
    case "KillShell":
    case "TaskStop":
      return { verb: "Stopped", chip: str(input.shell_id) || str(input.task_id), mono: true, icon: "run" };
    case "Grep":
      return { verb: "Searched", chip: str(input.pattern), mono: true, icon: "search" };
    case "Glob":
      return { verb: "Found files", chip: str(input.pattern), mono: true, icon: "search" };
    case "WebFetch":
      return { verb: "Fetched", chip: str(input.url).replace(/^https?:\/\//, ""), mono: true, icon: "web" };
    case "WebSearch":
      return { verb: "Searched the web", chip: str(input.query), mono: false, icon: "web" };
    case "Task":
    case "Agent":
      return { verb: str(input.subagent_type) ? `Agent ${str(input.subagent_type)}` : "Agent", chip: str(input.description), mono: false, icon: "agent" };
    case "Skill":
      return { verb: "Skill", chip: str(input.skill) || str(input.command), mono: true, icon: "agent" };
    case "SendMessage":
      return { verb: "Messaged", chip: firstLine(str(input.summary)) || str(input.to), mono: false, icon: "agent" };
    case "ToolSearch":
      return { verb: "Loaded tools", chip: str(input.query).replace(/^select:/, ""), mono: true, icon: "search" };
    case "LS":
      return { verb: "Listed", chip: base(input.path), mono: true, icon: "read" };
    case "NotebookRead":
      return { verb: "Read notebook", chip: base(input.notebook_path), mono: true, icon: "read" };
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as { status?: string }[]) : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return { verb: "Updated plan", chip: `${done}/${todos.length} done`, mono: false, icon: "plan" };
    }
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? (input.questions as { question?: string }[]) : [];
      return { verb: "Asked", chip: qs[0]?.question ?? "", mono: false, icon: "ask" };
    }
    case "ExitPlanMode":
      return { verb: "Proposed a plan", chip: firstLine(str(input.plan)).replace(/^#+\s*/, ""), mono: false, icon: "plan" };
    default: {
      if (name.startsWith("mcp__")) {
        const [, server, ...rest] = name.split("__");
        const verb = rest.join("__").replace(/_/g, " ").trim();
        return { verb: verb ? verb[0].toUpperCase() + verb.slice(1) : name, chip: server, mono: true, icon: "tool" };
      }
      const firstString = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return { verb: name, chip: firstLine(firstString ?? ""), mono: true, icon: "tool" };
    }
  }
}

/* ── result helpers ───────────────────────────────────────── */

const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

/** Strips harness wrappers from a tool result: system reminders (kept only when they are all there is) and error tags. */
export function cleanResult(text: string): string {
  const stripped = text.replace(REMINDER, "").replace(/<\/?tool_use_error>/g, "");
  if (stripped.trim()) return stripped.replace(/\s+$/, "");
  const reminders = [...text.matchAll(REMINDER)].map((m) => m[1].trim()).filter(Boolean);
  return reminders.join("\n");
}

export type NumberedLine = { n: number | null; text: string };

/** Read results come back as `cat -n` style lines (`  12\tcode` or `12→code`); returns them split, or null if it is not that shape. */
export function parseNumbered(text: string): NumberedLine[] | null {
  const lines = text.split("\n");
  const re = /^\s*(\d+)(?:\t|\u2192)(.*)$/;
  let hits = 0;
  const out = lines.map((line) => {
    const m = re.exec(line);
    if (!m) return { n: null, text: line };
    hits += 1;
    return { n: Number(m[1]), text: m[2] };
  });
  return hits > 0 && hits >= lines.length * 0.8 ? out : null;
}

/** Path relative to `root` when it lives underneath it. */
export function relativeTo(path: string, root: string): string {
  const r = root.replace(/\/+$/, "");
  return r && path.startsWith(`${r}/`) ? path.slice(r.length + 1) : path;
}

export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/", path.length - 2);
  return i === -1 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/** Index just past the JSON array that starts at `start` (a "["), honouring strings; -1 if unbalanced. */
function arrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i + 1;
  }
  return -1;
}

export type SearchLink = { title: string; url: string };

/** WebSearch results: pulls out the `Links: [...]` JSON blocks and returns the prose that remains. */
export function parseWebSearch(text: string): { links: SearchLink[]; rest: string } {
  const links: SearchLink[] = [];
  let rest = "";
  let cursor = 0;
  for (const m of text.matchAll(/Links:\s*\[/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (open < cursor) continue;
    const end = arrayEnd(text, open);
    if (end === -1) break;
    try {
      const parsed = JSON.parse(text.slice(open, end)) as unknown;
      if (Array.isArray(parsed)) {
        for (const l of parsed as { title?: unknown; url?: unknown }[]) {
          if (typeof l?.url === "string") links.push({ url: l.url, title: typeof l.title === "string" && l.title.trim() ? l.title : l.url });
        }
      }
      rest += text.slice(cursor, m.index);
      cursor = end;
    } catch {
      /* not JSON after all; leave it in the prose */
    }
  }
  rest += text.slice(cursor);
  rest = rest
    .split("\n")
    .filter((l) => !/^Web search results for query:/.test(l) && !/^REMINDER:/.test(l))
    .join("\n")
    .trim();
  return { links, rest };
}

/** Pretty-prints a JSON result; anything else comes back untouched. */
export function prettyJson(text: string): string {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};
