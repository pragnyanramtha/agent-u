"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeCard } from "./CodeCard";

/* `.prose-claude` sets `overflow-wrap: anywhere`, which also shrinks min-content
 * widths; inside table cells that squeezes columns down to one character per
 * line. Cells wrap at word boundaries instead and the table scrolls sideways. */
const cell = "[overflow-wrap:break-word] [word-break:normal] [&:not(:first-child)]:min-w-[5.5rem]";

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const lang = /language-([\w+-]+)/.exec(className ?? "")?.[1];
    const text = String(children ?? "");
    /* inline chips wrap like text; each line fragment keeps its own rounded edge */
    if (!lang && !text.includes("\n")) return <code className="[box-decoration-break:clone] [-webkit-box-decoration-break:clone]">{children}</code>;
    return <CodeCard code={text} label={lang} />;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div tabIndex={0} role="region" aria-label="Table" className="max-w-full overflow-x-auto overscroll-x-contain rounded-[2px]">
      <table className="min-w-full">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th className={cell} style={style}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className={cell} style={style}>
      {children}
    </td>
  ),
  img: ({ src, alt }) => (typeof src === "string" ? <img src={src} alt={alt ?? ""} loading="lazy" className="max-h-96 max-w-full rounded-card shadow-hairline" /> : null),
};

/** Assistant prose. Raw HTML in the transcript is never rendered. `compact` is the denser size used inside tool details. */
export const Markdown = memo(function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  return (
    <div
      className={`prose-claude min-w-0 [&_li>*+*]:mt-2 [&_.contains-task-list]:list-none! [&_.contains-task-list]:pl-0.5! [&_li>input]:mr-1.5 [&_li>input]:align-[-1px] ${compact ? "[&_:is(h1,h2,h3,h4)]:mt-3!" : ""}`}
      style={compact ? { fontSize: 13, lineHeight: 1.6 } : undefined}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
