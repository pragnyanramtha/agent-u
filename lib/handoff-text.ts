/* The first message of a session continued from another agent (see lib/server/handoff-shape.ts). */

export const HANDOFF_LEAD = "This conversation continues a session that started in ";
const NEXT = "Continue from there. The user's next message:\n\n";

export function parseHandoff(text: string): { from: string; title: string; next: string } | null {
  if (!text.startsWith(HANDOFF_LEAD)) return null;
  /* session lists may hold only the first few dozen characters */
  const nl = text.indexOf("\n");
  const head = text.slice(HANDOFF_LEAD.length, nl < 0 ? undefined : nl);
  const paren = head.indexOf(' ("');
  const comma = head.indexOf(", working in ");
  const from = head.slice(0, paren >= 0 ? paren : comma >= 0 ? comma : undefined).trim() || "another agent";
  const close = head.lastIndexOf('")');
  const title = paren >= 0 ? head.slice(paren + 3, close > paren ? close : undefined).trim() : "";
  const at = text.lastIndexOf(NEXT);
  return { from, title, next: at >= 0 ? text.slice(at + NEXT.length) : "" };
}

/** a short title for a continued session */
export function handoffTitle(text: string) {
  const h = parseHandoff(text);
  return h ? `${h.title || h.next.slice(0, 60) || "Session"} (from ${h.from})` : text;
}
