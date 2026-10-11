import { NextResponse, type NextRequest } from "next/server";
import { readJson } from "@/lib/server/http";
import { inputTarget, isTerminalKey, pressKey } from "@/lib/server/input";
import { isSessionId, liveTerminals } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/** Presses one whitelisted key in the session's terminal pane (Esc to interrupt, digits/Enter for dialogs). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSessionId(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const key = (await readJson(req)).key;
  if (!isTerminalKey(key)) return NextResponse.json({ error: "Unknown key." }, { status: 400 });
  const terminal = (await liveTerminals(0)).get(id);
  if (!terminal) return NextResponse.json({ error: "This session is not open in a terminal." }, { status: 409 });
  const target = await inputTarget(terminal.pid);
  if (!target) return NextResponse.json({ error: "Can't reach this terminal's pane." }, { status: 409 });
  try {
    await pressKey(target, key);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Couldn't press the key." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
