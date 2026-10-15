import { NextResponse, type NextRequest } from "next/server";
import { agentModels } from "@/lib/server/agents/models";
import { AGENT_IDS, type AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The models an agent CLI offers on this server, for the composer's model picker. */
export async function GET(req: NextRequest) {
  const agent = req.nextUrl.searchParams.get("agent") as AgentId | null;
  if (!agent || !AGENT_IDS.includes(agent) || agent === "claude") return NextResponse.json({ models: [] });
  return NextResponse.json({ models: await agentModels(agent, req.nextUrl.searchParams.get("profile")) });
}
