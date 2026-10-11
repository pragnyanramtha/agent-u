import { NextResponse, type NextRequest } from "next/server";
import { listCommands } from "@/lib/server/commands";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return NextResponse.json({ commands: await listCommands(req.nextUrl.searchParams.get("cwd") ?? undefined) });
}
