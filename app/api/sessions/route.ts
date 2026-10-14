import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getRun, startRun } from "@/lib/server/runner";
import { listSessions } from "@/lib/server/sessions";
import { parseMode, readJson, str } from "@/lib/server/http";
import type { AgentId } from "@/lib/types";
import { agentSummaries } from "@/lib/server/agents/bridge";
import { agentStart } from "@/lib/server/agents/routes";
import { once } from "@/lib/server/dedupe";
import { guardTurn } from "@/lib/server/fallback";
import { pickProfile, setSessionProfile } from "@/lib/server/profiles";

export const dynamic = "force-dynamic";

export async function GET() {
  const [sessions, others] = await Promise.all([listSessions(), agentSummaries().catch(() => [])]);
  const rows = [
    ...sessions.map((s) => {
      const run = getRun(s.id);
      return run ? { ...s, terminal: null, web: run.state } : { ...s, web: null };
    }),
    ...others,
  ].sort((a, b) => b.mtime - a.mtime);
  const projects = [...new Set(rows.map((s) => s.cwd).filter(Boolean))].slice(0, 30);
  return NextResponse.json({ sessions: rows, projects });
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  return once(body.clientId, () => start(body));
}

async function start(body: Record<string, unknown>) {
  const agent = str(body.agent) as AgentId | undefined;
  if (agent && agent !== "claude") return agentStart(agent, body);
  const text = str(body.text)?.trim();
  const cwd = str(body.cwd)?.trim();
  if (!text) return NextResponse.json({ error: "Write a first message to start the session." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: `No folder at ${cwd || "(empty)"} on the server.` }, { status: 400 });
  }
  const profile = pickProfile("claude", body.profile, null);
  const model = str(body.model) || undefined;
  const mode = parseMode(body.permissionMode) ?? "default";
  const run = startRun({ cwd, model, permissionMode: mode, profile });
  run.send(text);
  const id = await Promise.race([run.sessionId(), new Promise<string>((r) => setTimeout(() => r(""), 90_000))]);
  if (!id) {
    run.close();
    return NextResponse.json({ error: run.state.error ?? "Claude didn't start within 90 seconds." }, { status: 502 });
  }
  setSessionProfile(id, profile.id);
  guardTurn({ key: id, text, mode, model, profile });
  return NextResponse.json({ id });
}
