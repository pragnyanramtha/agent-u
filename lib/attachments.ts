/* Files attached in the composer are uploaded to the server and named at the end of the message, so every agent
 * (and a terminal session typed into) can open them by path. The thread shows them as attachments again. */

export const ATTACH_MARK = "Attached files:";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
export const isImagePath = (p: string) => IMAGE.test(p);

/** a name that survives a terminal (no spaces or shell-awkward characters) and keeps its extension */
export function attachName(name: string) {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80) || "file";
  const ext = dot > 0 ? name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toLowerCase() : "";
  return ext ? `${stem}.${ext}` : stem;
}

export function withAttachments(text: string, paths: string[]) {
  if (!paths.length) return text;
  const body = text.trim() || (paths.length === 1 ? "See the attached file." : "See the attached files.");
  return `${body}\n\n${ATTACH_MARK}\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

/* a terminal flattens the newlines to spaces, so the list is read either way */
const TAIL = /(?:^|\s)Attached files:((?:\s+-\s+\/\S+)+)\s*$/;

export function splitAttachments(text: string): { text: string; paths: string[] } {
  const m = TAIL.exec(text);
  if (!m) return { text, paths: [] };
  const paths = m[1]
    .split(/\s+-\s+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith("/"));
  return { text: text.slice(0, m.index).trimEnd(), paths };
}
