import { NextResponse } from "next/server";

/* Sends retried after a dropped connection carry the same client id; the second
 * one gets the first one's answer instead of posting the message again. */

type Saved = { at: number; done: Promise<{ status: number; body: unknown }> };
const TTL = 15 * 60_000;
const store = (): Map<string, Saved> => {
  const g = globalThis as typeof globalThis & { __agentuSends?: Map<string, Saved> };
  return (g.__agentuSends ??= new Map());
};

const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;

export async function once(clientId: unknown, fn: () => Promise<Response>): Promise<Response> {
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) return fn();
  const map = store();
  const now = Date.now();
  for (const [k, v] of map) if (now - v.at > TTL) map.delete(k);
  const hit = map.get(clientId);
  if (hit) {
    const { status, body } = await hit.done;
    return NextResponse.json(body, { status, headers: { "x-agent-u-replay": "1" } });
  }
  const done = fn().then(async (res) => ({ status: res.status, body: await res.clone().json().catch(() => ({})) }));
  map.set(clientId, { at: now, done });
  /* a failed send may be tried again for real */
  done.then((r) => r.status >= 400 && map.delete(clientId), () => map.delete(clientId));
  const r = await done;
  return NextResponse.json(r.body, { status: r.status });
}
