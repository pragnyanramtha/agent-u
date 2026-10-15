import { getRun } from "./runner";
import { listSessions } from "./sessions";
import { agentSummaries } from "./agents/bridge";
import type { SessionSummary } from "@/lib/types";

/** Every session the list shows, Claude and the other agents, newest first. */
export async function sessionRows(): Promise<SessionSummary[]> {
  const [sessions, others] = await Promise.all([listSessions(), agentSummaries().catch(() => [])]);
  return [
    ...sessions.map((s) => {
      const run = getRun(s.id);
      return run ? { ...s, terminal: null, web: run.state } : { ...s, web: null };
    }),
    ...others,
  ].sort((a, b) => b.mtime - a.mtime);
}
