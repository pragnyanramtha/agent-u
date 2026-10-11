import { NextResponse, type NextRequest } from "next/server";
import { parseMode, readJson, sessionContext, str } from "@/lib/server/http";
import { InputRefused, inputTarget, typeIntoTerminal } from "@/lib/server/input";
import { getRun, startRun } from "@/lib/server/runner";
import { liveTerminals } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/**
 * Sends a message to the one claude that owns this session; the server decides
 * where it goes, so a stale tab can't pick wrong:
 *  - a web run: straight into it
 *  - open in a terminal (zellij/tmux): typed into that pane
 *  - otherwise: resumed through the SDK under the same id
 * There is never a second claude or a copy.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(req);
  const text = str(body.text)?.trim();
  if (!text) return NextResponse.json({ error: "Message is empty." }, { status: 400 });

  const existing = getRun(id);
  if (existing) {
    existing.send(text);
    return NextResponse.json({ id: existing.state.sessionId, via: "web" });
  }

  const [ctx, terminal] = await Promise.all([sessionContext(id), liveTerminals(0).then((t) => t.get(id))]);
  if (!ctx && !terminal) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  if (terminal) {
    const target = await inputTarget(terminal.pid);
    if (!target) {
      return NextResponse.json(
        { error: `This session is running in ${terminal.multiplexer ?? "a terminal"} that the web can't type into. Reply there, or open it in zellij or tmux.`, code: "no_pane" },
        { status: 409 },
      );
    }
    let queued = false;
    try {
      ({ queued } = await typeIntoTerminal(target, text));
    } catch (err) {
      if (err instanceof InputRefused) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
      return NextResponse.json({ error: `Couldn't type into the terminal: ${err instanceof Error ? err.message.slice(0, 160) : err}` }, { status: 502 });
    }
    return NextResponse.json({ id, via: "terminal", queued });
  }

  if (!ctx) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  /* another request may have started a run while we were awaiting */
  const raced = getRun(id);
  if (raced) {
    raced.send(text);
    return NextResponse.json({ id: raced.state.sessionId, via: "web" });
  }

  const run = startRun({
    resume: id,
    cwd: ctx.cwd,
    model: str(body.model) || undefined,
    permissionMode: parseMode(body.permissionMode) ?? parseMode(ctx.meta.permissionMode) ?? "default",
  });
  run.send(text);
  return NextResponse.json({ id, via: "web" });
}
