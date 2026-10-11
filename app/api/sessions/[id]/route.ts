import { NextResponse, type NextRequest } from "next/server";
import { parseMode, sessionContext } from "@/lib/server/http";
import { getRun } from "@/lib/server/runner";
import { terminalFor } from "@/lib/server/sessions";
import { metaTitle, readHistory } from "@/lib/server/transcript";
import { parseSessionKey } from "@/lib/server/agents";
import { agentHistory } from "@/lib/server/agents/routes";

export const dynamic = "force-dynamic";

/**
 * Without `before`: the latest history page plus session state (same shape as the SSE history event, with `end`).
 * With `before`: an older page, walking backwards from that byte offset.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const key = parseSessionKey(decodeURIComponent(raw));
  if (!key) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (key.agent !== "claude") return agentHistory(key.agent, key.native, req.nextUrl.searchParams.get("before"));
  const id = key.native;
  const ctx = await sessionContext(id);
  const run = getRun(id);
  const beforeParam = req.nextUrl.searchParams.get("before");
  if (beforeParam === null) {
    const terminal = await terminalFor(id, Boolean(run));
    /* a terminal session that hasn't written its transcript yet still exists */
    if (!ctx && !run && !terminal) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const page = ctx ? await readHistory(ctx.file) : { entries: [], cursor: null, end: 0 };
    return NextResponse.json({
      type: "history",
      entries: run ? [...page.entries, ...run.extras] : page.entries,
      cursor: page.cursor,
      end: page.end,
      terminal,
      run: run ? run.state : null,
      title: (ctx && metaTitle(ctx.meta)) ?? "New session",
      cwd: ctx?.cwd ?? run?.cwd ?? terminal?.cwd ?? "",
      permissionMode: parseMode(ctx?.meta.permissionMode),
    });
  }
  if (!ctx) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const before = Math.floor(Number(beforeParam));
  if (!Number.isFinite(before) || before <= 0) return NextResponse.json({ entries: [], cursor: null });
  const { entries, cursor } = await readHistory(ctx.file, before);
  return NextResponse.json({ entries, cursor });
}
