import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

/* The file explorer works on the server's filesystem with the app user's permissions (the
 * same reach as the web terminal). Paths are absolute and resolved through symlinks. */

export class FsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function absPath(raw: string | null | undefined): string {
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) throw new FsError("Use an absolute path.", 400);
  return path.resolve(raw);
}

export async function real(raw: string | null | undefined) {
  const p = absPath(raw);
  try {
    return await fs.realpath(p);
  } catch (err) {
    throw fsError(err, p);
  }
}

export function fsError(err: unknown, p: string) {
  if (err instanceof FsError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return new FsError(`Nothing at ${p}.`, 404);
  if (code === "EACCES" || code === "EPERM") return new FsError(`No permission for ${p}.`, 403);
  if (code === "EEXIST") return new FsError(`${p} already exists.`, 409);
  if (code === "ENOTEMPTY") return new FsError(`${p} isn't empty.`, 409);
  if (code === "EISDIR") return new FsError(`${p} is a folder.`, 400);
  return new FsError(`Couldn't use ${p}: ${(err as Error)?.message ?? err}`, 500);
}

export const fsFail = (err: unknown, p = "") => {
  const e = fsError(err, p);
  return NextResponse.json({ error: e.message }, { status: e.status });
};

/** file names a user may create: no separators, no . or .. */
export function safeName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n || n === "." || n === ".." || n.includes("/") || n.includes("\0") || n.length > 255) throw new FsError(`"${n}" isn't a valid file name.`, 400);
  return n;
}

const TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json",
  md: "text/markdown", txt: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
  pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", wasm: "application/wasm", woff2: "font/woff2",
};

export const mimeOf = (p: string) => TYPES[path.extname(p).slice(1).toLowerCase()] ?? "application/octet-stream";

/** first bytes look like text (no NULs, mostly valid UTF-8) */
export function looksText(buf: Buffer) {
  if (!buf.length) return true;
  if (buf.includes(0)) return false;
  const s = buf.toString("utf8");
  const bad = (s.match(/\uFFFD/g) ?? []).length;
  return bad / s.length < 0.02;
}
