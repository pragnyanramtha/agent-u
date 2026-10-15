import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appServerTurn, threadSettings } from "@/lib/server/agents/codex-app";
import { answerTurn, turnState } from "@/lib/server/agents/cli-run";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentu-codex-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* a stand-in for `codex app-server`: starts a thread, asks for approval once per turn (a command, or a file change
 * outside the folder), logs what it was told, then completes the turn */
const fake = path.join(dir, "codex");
fs.writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require("fs");
const log = (o) => fs.appendFileSync(${JSON.stringify(path.join(dir, "log"))}, JSON.stringify(o) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === "initialize") out({ id: m.id, result: {} });
    else if (m.method === "thread/start") { log({ settings: m.params }); out({ id: m.id, result: { thread: { id: "t1" } } }); }
    else if (m.method === "turn/start") {
      out({ id: m.id, result: {} });
      const kind = m.params.input[0].text;
      if (kind === "edit") out({ id: 99, method: "item/fileChange/requestApproval", params: { threadId: "t1", itemId: "i", grantRoot: "/etc", reason: "needs /etc" } });
      else if (kind === "abandon") setTimeout(() => out({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } }), 300);
      else out({ id: 98, method: "item/commandExecution/requestApproval", params: { threadId: "t1", itemId: "i", command: "rm -rf build", cwd: "/w", reason: "cleanup" } });
    } else if (m.id === 98 || m.id === 99) {
      log({ answer: m.id, result: m.result });
      out({ method: "turn/completed", params: { threadId: "t1", turn: { status: "completed" } } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  { mode: 0o755 },
);
const logged = () => (fs.existsSync(path.join(dir, "log")) ? fs.readFileSync(path.join(dir, "log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const until = async (what: string, fn: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
};

describe("codex thread settings", () => {
  it("maps the approval modes", () => {
    expect(threadSettings("default")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(threadSettings("acceptEdits")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(threadSettings("plan")).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(threadSettings("bypassPermissions", "gpt-5")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access", model: "gpt-5" });
  });
});

describe("codex approvals", () => {
  it("shows a command approval and passes Allow back", async () => {
    const key = "codex:approve-cmd";
    appServerTurn({ key, bin: fake, cwd: dir, text: "cmd", mode: "default" });
    await until("the approval", () => (turnState(key)?.pending?.length ?? 0) > 0);
    const ask = turnState(key)!.pending![0];
    expect(ask).toMatchObject({ kind: "permission", requestId: "codex-98", toolName: "Bash", title: "Run rm -rf build", description: "cleanup", canAlwaysAllow: true });
    expect(turnState(key)?.status).toBe("running");
    expect(answerTurn(key, "codex-98", { allow: true, always: false })).toBe(true);
    expect(turnState(key)?.pending).toEqual([]);
    expect(answerTurn(key, "codex-98", { allow: true, always: false })).toBe(false);
    await until("the turn to end", () => turnState(key)?.status === "idle");
    expect(logged()).toContainEqual({ answer: 98, result: { decision: "accept" } });
    expect(logged()).toContainEqual({ settings: expect.objectContaining({ approvalPolicy: "untrusted", sandbox: "workspace-write" }) });
  });

  it("passes Deny and Always allow back for file changes", async () => {
    const key = "codex:approve-edit";
    appServerTurn({ key, bin: fake, cwd: dir, text: "edit", mode: "acceptEdits" });
    await until("the approval", () => (turnState(key)?.pending?.length ?? 0) > 0);
    expect(turnState(key)!.pending![0]).toMatchObject({ toolName: "Edit", title: "Write outside the folder, in /etc" });
    answerTurn(key, "codex-99", { allow: false, always: false });
    await until("the turn to end", () => turnState(key)?.status === "idle");
    expect(logged()).toContainEqual({ answer: 99, result: { decision: "decline" } });
  });

  it("drops approvals still open when the turn ends", async () => {
    const key = "codex:approve-gone";
    appServerTurn({ key, bin: fake, cwd: dir, text: "abandon", mode: "default" });
    await until("the turn to end", () => turnState(key)?.status === "idle");
    expect(turnState(key)?.pending ?? []).toEqual([]);
    expect(answerTurn(key, "codex-1", { allow: true, always: false })).toBe(false);
  });
});
