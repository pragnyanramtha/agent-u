import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { fsFail, mimeOf, real } from "@/lib/server/files";

export const dynamic = "force-dynamic";

/**
 * A file's bytes. ?download=1 saves it instead of showing it. Range requests are honoured,
 * so media can seek and an interrupted download can pick up where it stopped.
 * Markup that can run script (HTML, SVG) is sandboxed: it gets an opaque origin, never this site's cookies.
 */
export async function GET(req: NextRequest) {
  const want = req.nextUrl.searchParams.get("path");
  try {
    const p = await real(want);
    const st = await fs.stat(p);
    if (!st.isFile()) return Response.json({ error: `${p} isn't a file.` }, { status: 400 });
    const type = mimeOf(p);
    const headers = new Headers({
      "Content-Type": type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache",
      "Last-Modified": new Date(st.mtimeMs).toUTCString(),
    });
    /* browsers won't show a PDF in a sandboxed document; everything else gets no script and no origin */
    headers.set(
      "Content-Security-Policy",
      `${type === "application/pdf" ? "" : "sandbox; "}default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    const name = path.basename(p);
    const download = req.nextUrl.searchParams.get("download") === "1";
    headers.set("Content-Disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`);

    let start = 0;
    let end = st.size - 1;
    let status = 200;
    const range = req.headers.get("range");
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && st.size > 0) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
      } else if (m[2]) start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${st.size}` } });
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${st.size}`);
    }
    headers.set("Content-Length", String(st.size === 0 ? 0 : end - start + 1));
    if (st.size === 0) return new Response(null, { status: 200, headers });
    const stream = createReadStream(p, { start, end });
    req.signal.addEventListener("abort", () => stream.destroy(), { once: true });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
  } catch (err) {
    return fsFail(err, want ?? "");
  }
}
