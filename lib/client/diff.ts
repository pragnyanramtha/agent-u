export type DiffLine = { tone: "add" | "del" | "ctx"; text: string; old: number | null; cur: number | null };

/** Line diff via LCS. Large inputs fall back to "all removed, then all added". */
export function lineDiff(before: string, after: string, max = 400): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > max || b.length > max) {
    return [
      ...a.map((text, i) => ({ tone: "del" as const, text, old: i + 1, cur: null })),
      ...b.map((text, i) => ({ tone: "add" as const, text, old: null, cur: i + 1 })),
    ];
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ tone: "ctx", text: a[i], old: ++i, cur: ++j });
    else if (j < b.length && (i === a.length || dp[i][j + 1] > dp[i + 1][j])) out.push({ tone: "add", text: b[j], old: null, cur: ++j });
    else out.push({ tone: "del", text: a[i], old: ++i, cur: null });
  }
  return out;
}

/** Keeps changed lines plus a little context; long unchanged stretches collapse to a gap marker. */
export function compact(lines: DiffLine[], context = 2): (DiffLine | { gap: number })[] {
  const keep = lines.map((l) => l.tone !== "ctx");
  const near = keep.map((_, i) => keep.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
  const out: (DiffLine | { gap: number })[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (near[i]) {
      if (skipped) out.push({ gap: skipped });
      skipped = 0;
      out.push(l);
    } else skipped += 1;
  });
  if (skipped) out.push({ gap: skipped });
  return out;
}
