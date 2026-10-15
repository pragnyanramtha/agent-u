import { describe, expect, it } from "vitest";
import { dashRows } from "@/lib/server/agents/models";
import { isPlainText } from "@/lib/client/highlight";
import { setServerHome, shortPath } from "@/lib/client/api";

describe("cursor-agent models output", () => {
  const out = [
    "\x1b[1mAvailable models\x1b[0m",
    "",
    "auto - Auto (current, default)",
    "gpt-5.3-codex - Codex 5.3",
    "claude-opus-5-thinking-high - Claude Opus 5 1M Thinking",
    "grok-4.7-low-fast - Grok 4.7  Low Fast\u200b\u200b",
    "Tip: use --model <id>",
  ].join("\n");

  it("parses id - name rows, dropping ANSI, zero-width chars and the current/default marker", () => {
    const rows = dashRows(out);
    expect(rows.map((r) => r.key)).toEqual(["auto", "gpt-5.3-codex", "claude-opus-5-thinking-high", "grok-4.7-low-fast"]);
    expect(rows[0].name).toBe("Auto");
    expect(rows[3].name).toBe("Grok 4.7  Low Fast");
  });

  it("returns nothing for logged-out or empty output", () => {
    expect(dashRows("Error: Not logged in. Run `devin auth login` to authenticate.")).toEqual([]);
    expect(dashRows("")).toEqual([]);
  });
});

describe("plain text detection", () => {
  it("treats prose and data files as plain", () => {
    for (const n of ["notes.txt", "README.md", "a.LOG", "data.csv", "x.tsv", "text", "markdown"]) expect(isPlainText(n)).toBe(true);
  });
  it("keeps code highlighted", () => {
    for (const n of ["a.ts", "main.py", "ts", "bash", undefined, ""]) expect(isPlainText(n)).toBe(false);
  });
});

describe("shortPath", () => {
  it("only abbreviates the server user's own home", () => {
    setServerHome("/home/ubuntu");
    expect(shortPath("/home/ubuntu/proj")).toBe("~/proj");
    expect(shortPath("/home/ubuntu")).toBe("~");
    expect(shortPath("/home/ubuntu2/x")).toBe("/home/ubuntu2/x");
    expect(shortPath("/home/pik/edgebench")).toBe("/home/pik/edgebench");
  });
});
