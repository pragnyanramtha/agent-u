import os from "node:os";
import path from "node:path";

const home = os.homedir();

export const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(home, ".claude");
export const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");
export const LIVE_SESSIONS_DIR = path.join(CLAUDE_HOME, "sessions");

/** Path to the `claude` binary the SDK should drive; falls back to the SDK's bundled CLI. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN || undefined;

/** Project folders (substring match) that never show up in the session list. */
export const HIDDEN_PROJECTS = (process.env.HIDE_PROJECTS ?? "claude-mem-observer")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Web runs with no viewers are shut down after this long idle, freeing the claude process. */
export const IDLE_REAP_MS = Number(process.env.IDLE_REAP_MS ?? 20 * 60_000);

/** Claude Code names project folders after the cwd with every non-alphanumeric char replaced by "-". */
export const projectDirFor = (cwd: string) => path.join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
