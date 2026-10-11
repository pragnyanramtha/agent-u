import { NextResponse } from "next/server";
import { installedAgents } from "@/lib/server/agents/bridge";

export const dynamic = "force-dynamic";

/** Which agent CLIs are installed on the server (Claude is always available through the SDK). */
export async function GET() {
  return NextResponse.json({ agents: [{ id: "claude", label: "Claude", installed: true }, ...(await installedAgents())] });
}
