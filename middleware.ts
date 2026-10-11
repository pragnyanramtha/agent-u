import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, verifySession } from "@/lib/auth";

const PUBLIC = ["/login", "/api/auth/login", "/manifest.webmanifest", "/icon.svg", "/apple-touch-icon.png"];

/** "null" (sandboxed/opaque origins) and garbage don't parse; treat them as no origin. */
function originHost(origin: string | null) {
  try {
    return origin ? new URL(origin).host : null;
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const api = pathname.startsWith("/api/");

  /* Defence in depth on top of SameSite=strict: state-changing API calls must come from this origin.
   * Behind a tunnel Host is the public name and x-forwarded-host may be missing or point elsewhere, so either may match. */
  if (api && req.method !== "GET" && req.method !== "HEAD") {
    const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")?.split(",")[0].trim()].filter(Boolean);
    if (!hosts.includes(originHost(req.headers.get("origin")))) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  if (PUBLIC.includes(pathname)) return NextResponse.next();
  if (await verifySession(req.cookies.get(COOKIE)?.value)) return NextResponse.next();

  if (api) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  /* build from the Host the browser used: behind a tunnel or proxy, req.nextUrl says 127.0.0.1:3311 */
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return NextResponse.redirect(new URL("/login", `${proto}://${host}`));
}

export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
