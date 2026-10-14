import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { parseSessionKey, sessionKey } from "@/lib/server/agents";
import { adapterFor } from "@/lib/server/agents";
import { readJson, sessionContext, str } from "@/lib/server/http";
import { getProfile, pickProfile } from "@/lib/server/profiles";
import { getRun } from "@/lib/server/runner";
import { killTerminal, launchAgent, listTerminals } from "@/lib/server/terminals";

export const dynamic = "force-dynamic";

/** Terminals the server keeps (shells and agents started from the web), running or recently finished. */
export async function GET() {
  try {
    return NextResponse.json(await listTerminals());
  } catch (err) {
    return NextResponse.json({ terminals: [], tmux: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Starts an agent's own TUI in a kept terminal: { profile, cwd } for a new session,
 * or { session } to open an existing one interactively (its folder and agent come from the session).
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const raw = str(body.session);
  let cwd = str(body.cwd)?.trim() ?? "";
  let profile = getProfile(str(body.profile));
  let native: string | null = null;
  let key: string | null = null;
  if (raw) {
    const k = parseSessionKey(raw);
    if (!k) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    key = sessionKey(k.agent, k.native);
    native = k.native;
    if (k.agent === "claude") {
      if (getRun(k.native)?.state.status === "running") return NextResponse.json({ error: "Claude is working on a message from the web. Open the terminal once it's done.", code: "busy" }, { status: 409 });
      getRun(k.native)?.close();
      cwd = (await sessionContext(k.native))?.cwd ?? cwd;
    } else {
      const a = await adapterFor(k.agent);
      if (a?.runState(k.native)?.status === "running") return NextResponse.json({ error: `${a.label} is working on a message from the web. Open the terminal once it's done.`, code: "busy" }, { status: 409 });
      cwd = (await a?.get(k.native))?.cwd ?? cwd;
    }
    profile = pickProfile(k.agent, str(body.profile), key);
  }
  if (!profile) return NextResponse.json({ error: "Pick an agent profile." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: `No folder at ${cwd || "(empty)"} on the server.` }, { status: 400 });
  }
  try {
    const t = await launchAgent({ profile, cwd, session: native, sessionKey: key, model: str(body.model) || null, cols: Number(body.cols) || undefined, rows: Number(body.rows) || undefined });
    return NextResponse.json({ ...t, label: profile.label });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = str((await readJson(req)).id);
  if (!id) return NextResponse.json({ error: "Which terminal?" }, { status: 400 });
  try {
    return NextResponse.json(await killTerminal(id));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
