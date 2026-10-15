import { beforeEach, describe, expect, it, vi } from "vitest";
import { carryOver, load, save } from "@/lib/client/storage";

const mem = new Map<string, string>();
beforeEach(() => {
  mem.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > 1000) throw new DOMException("quota", "QuotaExceededError");
      mem.set(k, v);
    },
    removeItem: (k: string) => void mem.delete(k),
  });
});

describe("session storage", () => {
  it("never throws on quota errors", () => {
    expect(() => save("draft:x", "y".repeat(5000))).not.toThrow();
    expect(load("draft:x")).toBeNull();
  });

  it("moves bubbles and the draft to the new session id, using the newest bubbles", () => {
    save("pending:old", JSON.stringify([{ localId: "a", state: "sending" }]));
    save("draft:old", "half typed");
    carryOver("old", "new", [{ localId: "a", state: "sent" }]);
    expect(JSON.parse(load("pending:new")!)).toEqual([{ localId: "a", state: "sent" }]);
    expect(load("draft:new")).toBe("half typed");
    expect(load("pending:old")).toBeNull();
    expect(load("draft:old")).toBeNull();
  });

  it("doesn't overwrite a draft already typed in the new session", () => {
    save("draft:old", "old text");
    save("draft:new", "new text");
    carryOver("old", "new");
    expect(load("draft:new")).toBe("new text");
  });

  it("is a no-op for the same id", () => {
    save("draft:same", "keep");
    carryOver("same", "same", []);
    expect(load("draft:same")).toBe("keep");
  });
});
