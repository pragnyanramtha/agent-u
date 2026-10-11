import { NextResponse, type NextRequest } from "next/server";
import { inputTarget, paneScreen, readPrompt } from "@/lib/server/input";
import { isSessionId, liveTerminals } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/** What the session's terminal pane shows right now, plus whether its prompt can take input. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSessionId(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const terminal = (await liveTerminals(0)).get(id);
  if (!terminal) return NextResponse.json({ error: "Not open in a terminal." }, { status: 404 });
  const target = await inputTarget(terminal.pid);
  if (!target) return NextResponse.json({ error: "Can't read this terminal." }, { status: 404 });
  try {
    const ansi = await paneScreen(target, true);
    const screen = ansi.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+$/, "");
    return NextResponse.json({ screen, prompt: readPrompt(ansi) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "Couldn't read the terminal." }, { status: 502 });
  }
}
