import { describe, expect, it } from "vitest";
import { contextOf, contextWindow, type UsageEntry } from "@/lib/client/usage";

const u = (model: string, input: number, extra: Partial<UsageEntry> = {}): UsageEntry => ({ kind: "usage", id: "u", ts: "", model, input, cacheRead: 0, cacheWrite: 0, output: 0, ...extra });

describe("context window", () => {
  it("uses the window the agent recorded", () => {
    expect(contextWindow(u("claude-opus-5-5-medium", 25_000, { window: 300_000 }))).toBe(300_000);
    expect(contextWindow(u("gpt-6.1-sol", 10_000, { window: 272_000 }))).toBe(272_000);
  });

  it("gives Claude Code models 1M, and old claude-3 models 200k", () => {
    expect(contextWindow(u("claude-opus-5-5", 50_000))).toBe(1_000_000);
    expect(contextWindow(u("claude-3-5-sonnet-20241022", 50_000))).toBe(200_000);
    expect(contextWindow(u("claude-3-5-sonnet-20241022", 250_000))).toBe(1_000_000);
  });

  it("falls back to 200k for other agents' models, unless the name or usage says more", () => {
    expect(contextWindow(u("opencode/big-pickle", 44_000))).toBe(200_000);
    expect(contextWindow(u("gpt-5.6-sol", 44_000))).toBe(200_000);
    expect(contextWindow(u("gemini-1m-pro", 44_000))).toBe(1_000_000);
    expect(contextWindow(u("opencode/big-pickle", 250_000))).toBe(1_000_000);
  });

  it("reports percent used and free space against that window", () => {
    const c = contextOf(u("cursor", 25_000, { window: 300_000, cacheRead: 5_000 }));
    expect(c.used).toBe(30_000);
    expect(c.pct).toBeCloseTo(0.1);
    expect(c.free).toBe(270_000);
  });
});
