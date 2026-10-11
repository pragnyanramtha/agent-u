import type { ReactNode } from "react";

/* Light syntax coloring lifted from Beautiful UI's CodeBlock: keywords,
 * function calls, strings and numbers. Deliberately small; it's a hint, not a parser. */

const KEYWORDS = new Set([
  "import", "from", "export", "default", "async", "function", "const", "let", "var", "await", "return", "if", "else",
  "for", "while", "new", "throw", "try", "catch", "null", "true", "false", "undefined", "def", "class", "self", "None",
  "True", "False", "fn", "pub", "use", "struct", "impl", "match", "elif", "in", "not", "and", "or", "type", "interface",
]);
const TOKEN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|#.*$|\/\/.*$|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined|def|class|self|None|True|False|fn|pub|use|struct|impl|match|elif|in|not|and|or|type|interface)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;

export function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const idx = m.index ?? 0;
    const t = m[0];
    if (idx > last) nodes.push(<span key={k++}>{text.slice(last, idx)}</span>);
    let style: { color: string; fontWeight?: number; fontStyle?: string };
    if (t.startsWith("#") || t.startsWith("//")) style = { color: "var(--ink-3)", fontStyle: "italic" };
    else if (/^["'`]/.test(t) || /^\d/.test(t)) style = { color: "var(--orange)" };
    else if (KEYWORDS.has(t)) style = { color: "var(--accent-ink)" };
    else style = { color: "var(--ink)", fontWeight: 500 };
    nodes.push(<span key={k++} style={style}>{t}</span>);
    last = idx + t.length;
  }
  if (last < text.length) nodes.push(<span key={k++}>{text.slice(last)}</span>);
  return nodes;
}
