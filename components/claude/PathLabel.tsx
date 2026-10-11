import { splitPath } from "@/lib/client/tools";

/** A file path that truncates its directory first so the file name stays readable on narrow screens. */
export function PathLabel({ path, className = "" }: { path: string; className?: string }) {
  const { dir, base } = splitPath(path);
  return (
    <span title={path} translate="no" className={`flex min-w-0 font-mono ${className}`}>
      {dir && <span className="min-w-0 truncate text-ink-3">{dir}</span>}
      <span className="max-w-full shrink-0 truncate text-ink-2">{base}</span>
    </span>
  );
}
