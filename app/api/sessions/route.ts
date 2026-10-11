import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getRun, startRun } from "@/lib/server/runner";
import { listSessions } from "@/lib/server/sessions";
import { parseMode, readJson, str } from "@/lib/server/http";
import type { AgentId } from "@/lib/types";
import { agentSummaries } from "@/lib/server/agents/bridge";
import { agentStart } from "@/lib/server/agents/routes";

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
  const agent = str(body.agent) as AgentId | undefined;
  if (agent && agent !== "claude") return agentStart(agent, body);
  const text = str(body.text)?.trim();
  const cwd = str(body.cwd)?.trim();
  if (!text) return NextResponse.json({ error: "Write a first message to start the session." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: `No folder at ${cwd || "(empty)"} on the server.` }, { status: 400 });
  }
  const run = startRun({ cwd, model: str(body.model) || undefined, permissionMode: parseMode(body.permissionMode) ?? "default" });
  run.send(text);
  const id = await Promise.race([run.sessionId(), new Promise<string>((r) => setTimeout(() => r(""), 90_000))]);
  if (!id) {
    run.close();
    return NextResponse.json({ error: run.state.error ?? "Claude didn't start within 90 seconds." }, { status: 502 });
  }
  return NextResponse.json({ id });
}
