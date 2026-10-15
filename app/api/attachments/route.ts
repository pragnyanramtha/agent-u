import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const ATTACH_ROOT = process.env.AGENT_U_ATTACH || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "agent-u", "attachments");
const KEEP_MS = 14 * 24 * 60 * 60_000;

async function sweep() {
  const now = Date.now();
  for (const d of await fs.readdir(ATTACH_ROOT).catch(() => [])) {
    const p = path.join(ATTACH_ROOT, d);
    const st = await fs.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > KEEP_MS) await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A new folder for one message's attachments; the composer uploads into it with /api/files/upload. */
export async function POST() {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(ATTACH_ROOT, `${day}-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  void sweep();
  return NextResponse.json({ dir });
}
