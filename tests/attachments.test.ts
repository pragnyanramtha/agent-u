import { describe, expect, it } from "vitest";
import { attachName, isImagePath, splitAttachments, withAttachments } from "@/lib/attachments";
import { typeable } from "@/lib/server/input";

describe("attachments in a message", () => {
  const paths = ["/home/u/.cache/agent-u/attachments/2026-10-15-ab12/screen.png", "/home/u/.cache/agent-u/attachments/2026-10-15-ab12/log.txt"];

  it("round-trips through the message text", () => {
    const text = withAttachments("Why does this fail?", paths);
    expect(text).toContain("Attached files:\n- /home/u/");
    expect(splitAttachments(text)).toEqual({ text: "Why does this fail?", paths });
  });

  it("still reads after a terminal flattened the newlines", () => {
    const flat = typeable(withAttachments("Why does\nthis fail?", paths));
    expect(splitAttachments(flat)).toEqual({ text: "Why does this fail?", paths });
  });

  it("gives files alone a message", () => {
    expect(splitAttachments(withAttachments("  ", paths.slice(0, 1))).text).toBe("See the attached file.");
    expect(splitAttachments(withAttachments("", paths)).text).toBe("See the attached files.");
  });

  it("leaves messages without the list alone, including ones that only mention it", () => {
    expect(splitAttachments("plain")).toEqual({ text: "plain", paths: [] });
    const quoted = "The format is 'Attached files:' then a list. Ok?";
    expect(splitAttachments(quoted)).toEqual({ text: quoted, paths: [] });
    expect(withAttachments("x", [])).toBe("x");
  });
});

describe("attachName", () => {
  it("keeps the extension and drops what a terminal would trip on", () => {
    expect(attachName("Screen Shot 2026-10-15 at 9.41.03 AM.png")).toBe("Screen-Shot-2026-10-15-at-9.41.03-AM.png");
    expect(attachName("résumé (final).PDF")).toBe("resume-final.pdf");
    expect(attachName("$(rm -rf ~);.sh")).toBe("rm-rf.sh");
    expect(attachName(".png")).toBe("png");
    expect(attachName("")).toBe("file");
    expect(attachName("a".repeat(300) + ".txt")).toHaveLength(84);
  });

  it("knows images", () => {
    expect(isImagePath("/x/a.PNG")).toBe(true);
    expect(isImagePath("/x/a.jpeg")).toBe(true);
    expect(isImagePath("/x/a.pdf")).toBe(false);
  });
});
