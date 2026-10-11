#!/usr/bin/env node
/* Tests for the Cursor adapter (lib/server/agents/cursor*.ts) without Next:
 *   node --experimental-strip-types scripts/test-cursor-adapter.mjs [agentsDir] [--start <cwd>] [--live]
 * - unit: stream-json -> Entry mapping (sample shaped like real cursor-agent output)
 * - unit: store.db -> Entry mapping, against a synthetic store built with the real layout
 * - adapter: binary(), list(), get(), history(), watch() on the synthetic store
 * - --start <cwd>: a real start() (expects a clean "not logged in" error where the CLI isn't logged in)
 * - --live: list() against the real ~/.cursor and print the newest chat's history summary */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { register } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* extensionless relative imports -> .ts (Next resolves them; plain node doesn't) */
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); }
  catch (err) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + ".ts", ctx);
    throw err;
  }
}`),
);

const argv = process.argv.slice(2);
const dirArg = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--start");
const agentsDir = path.resolve(dirArg ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "lib", "server", "agents"));
const startCwd = argv.includes("--start") ? argv[argv.indexOf("--start") + 1] : null;
const live = argv.includes("--live");
const load = (f) => import(pathToFileURL(path.join(agentsDir, f)).href);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err?.stack?.split("\n").slice(0, 4).join("\n     ") ?? err}`);
  }
}

/* ── 1. stream-json mapping ───────────────────────────────── */

const SID = "c6b62c6f-7ead-4fd6-9922-e952131177ff";
const sample = [
  { type: "system", subtype: "init", apiKeySource: "login", cwd: "/tmp/p", session_id: SID, model: "Claude 4 Sonnet", permissionMode: "default" },
  { type: "user", message: { role: "user", content: [{ type: "text", text: "Read README.md and create a summary" }] }, session_id: SID },
  { type: "thinking", subtype: "delta", text: "Need to read ", session_id: SID, timestamp_ms: 1791735164696 },
  { type: "thinking", subtype: "delta", text: "the file first.", session_id: SID, timestamp_ms: 1791735164702 },
  { type: "thinking", subtype: "completed", session_id: SID, timestamp_ms: 1791735164703 },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll read the README.md file" }] }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_1", tool_call: { readToolCall: { args: { path: "README.md" } } }, session_id: SID },
  { type: "tool_call", subtype: "completed", call_id: "toolu_1", tool_call: { readToolCall: { args: { path: "README.md" }, result: { success: { content: "# Project\n\nThis is a sample project...", isEmpty: false, exceededLimit: false, totalLines: 54, totalChars: 1254 } } } }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_2", tool_call: { shellToolCall: { args: { command: "echo hi", workingDirectory: "", timeout: 30000, description: "echo hi" } } }, session_id: SID },
  { type: "tool_call", subtype: "completed", call_id: "toolu_2", tool_call: { shellToolCall: { args: { command: "echo hi", description: "echo hi" }, result: { success: { command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "", interleavedOutput: "hi\n" } } } }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_3", tool_call: { writeToolCall: { args: { path: "summary.txt", fileText: "# README Summary\n\nThis project contains...", toolCallId: "toolu_3" } } }, session_id: SID },
  { type: "tool_call", subtype: "completed", call_id: "toolu_3", tool_call: { writeToolCall: { args: { path: "summary.txt", fileText: "# README Summary" }, result: { success: { path: "/tmp/p/summary.txt", linesCreated: 19, fileSize: 942 } } } }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_4", tool_call: { editToolCall: { args: { path: "/tmp/p/b.txt", streamContent: "ciao" } } }, session_id: SID },
  { type: "tool_call", subtype: "completed", call_id: "toolu_4", tool_call: { editToolCall: { args: { path: "/tmp/p/b.txt", streamContent: "ciao" }, result: { success: { path: "/tmp/p/b.txt", linesAdded: 1, linesRemoved: 1, diffString: "-bye\n+ciao", beforeFullFileContent: "bye", afterFullFileContent: "ciao", message: "The file /tmp/p/b.txt has been updated." } } } }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_5", tool_call: { grepToolCall: { args: { pattern: "TODO", path: "/tmp/p", glob: "*.ts" } } }, session_id: SID },
  { type: "tool_call", subtype: "completed", call_id: "toolu_5", tool_call: { grepToolCall: { args: { pattern: "TODO" }, result: { error: { error: "ripgrep failed" } } } }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_6", tool_call: { updateTodosToolCall: { args: { todos: [{ id: "1", content: "Read", status: "TODO_STATUS_COMPLETED" }, { id: "2", content: "Write", status: "TODO_STATUS_IN_PROGRESS" }], merge: false } } }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_7", tool_call: { globToolCall: { args: { globPattern: "**/*.md", targetDirectory: "/tmp/p" } } }, session_id: SID },
  { type: "tool_call", subtype: "started", call_id: "toolu_8", tool_call: { function: { name: "LS", arguments: '{"target_directory":"/tmp/p"}' } }, session_id: SID },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done! I've created the summary in summary.txt" }] }, session_id: SID },
  { type: "result", subtype: "success", duration_ms: 5234, duration_api_ms: 5234, is_error: false, result: "...", session_id: SID, request_id: "r1", usage: { inputTokens: 8, outputTokens: 523, cacheReadTokens: 61254, cacheWriteTokens: 17463 } },
];

await test("stream-json -> entries", async () => {
  const { streamEntries } = await load("cursor-stream.ts");
  const entries = streamEntries(sample.map((e, i) => JSON.stringify({ ...e, _ts: 1791735160000 + i, _n: i })).join("\n"));
  const kinds = entries.map((e) => e.kind).join(",");
  assert.equal(kinds, "user,thinking,text,tool,result,tool,result,tool,result,tool,result,tool,result,tool,tool,tool,text,usage");
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, "ids unique");
  const [user, thinking, text, read, readRes, bash, bashRes, write, writeRes, edit, , grep, grepRes, todo, glob, ls, , usage] = entries;
  assert.equal(user.text, "Read README.md and create a summary");
  assert.equal(thinking.text, "Need to read the file first.");
  assert.equal(text.text, "I'll read the README.md file");
  assert.deepEqual([read.name, read.input], ["Read", { file_path: "README.md" }]);
  assert.equal(readRes.toolUseId, read.toolUseId);
  assert.deepEqual(readRes.result, { text: "# Project\n\nThis is a sample project...", isError: false, truncated: false });
  assert.deepEqual([bash.name, bash.input], ["Bash", { command: "echo hi", description: "echo hi" }]);
  assert.deepEqual(bashRes.result, { text: "hi\n", isError: false, truncated: false });
  assert.deepEqual([write.name, write.input], ["Write", { file_path: "summary.txt", content: "# README Summary\n\nThis project contains..." }]);
  assert.match(writeRes.result.text, /summary\.txt/);
  assert.deepEqual([edit.name, edit.input], ["Edit", { file_path: "/tmp/p/b.txt", old_string: "bye", new_string: "ciao" }], "finished edit shows the file before/after");
  assert.deepEqual([grep.name, grep.input], ["Grep", { pattern: "TODO", path: "/tmp/p", glob: "*.ts" }]);
  assert.deepEqual(grepRes.result, { text: "ripgrep failed", isError: true, truncated: false });
  assert.deepEqual([todo.name, todo.input], ["TodoWrite", { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }] }]);
  assert.deepEqual([glob.name, glob.input], ["Glob", { pattern: "**/*.md", path: "/tmp/p" }]);
  assert.deepEqual([ls.name, ls.input], ["LS", { path: "/tmp/p" }]);
  assert.deepEqual({ ...usage, id: undefined, ts: undefined }, { kind: "usage", id: undefined, ts: undefined, model: "Claude 4 Sonnet", input: 8, cacheRead: 61254, cacheWrite: 17463, output: 523 });
  assert.equal(user.ts, new Date(1791735160001).toISOString());
});

await test("tool result clipping", async () => {
  const { mapStreamTool } = await load("cursor-tools.ts");
  const r = mapStreamTool({ readToolCall: { args: { path: "x" }, result: { success: { content: "a".repeat(9000) } } } }).result;
  assert.equal(r.text.length, 8000);
  assert.equal(r.truncated, true);
});

/* ── 2. synthetic store.db with the real layout ────────────── */

const enc = new TextEncoder();
const varint = (n) => {
  const out = [];
  while (n >= 128) {
    out.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
/** fields: [n, number | string | Uint8Array] */
const pb = (fields) => {
  const out = [];
  for (const [n, v] of fields) {
    if (typeof v === "number") out.push(...varint(n * 8), ...varint(v));
    else {
      const b = typeof v === "string" ? enc.encode(v) : v;
      out.push(...varint(n * 8 + 2), ...varint(b.length), ...b);
    }
  }
  return new Uint8Array(out);
};

function buildStore(base, id, cwd) {
  const dir = path.join(base, "chats", createHash("md5").update(cwd).digest("hex"), id);
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const db = new DatabaseSync(path.join(dir, "store.db"));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);");
  const put = (data) => {
    const b = typeof data === "string" ? enc.encode(data) : data;
    const h = createHash("sha256").update(b).digest();
    db.prepare("INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)").run(h.toString("hex"), b);
    return new Uint8Array(h);
  };
  const json = (o) => put(JSON.stringify(o));
  const msgs = [
    json({ role: "system", content: "You are an AI coding assistant" }),
    json({ role: "user", content: "<user_info>\nWorkspace Path: " + cwd + "\n</user_info>" }),
    json({ role: "user", content: [{ type: "text", text: "<timestamp>Sunday, Oct 11, 2026, 9:42 PM (UTC+5:30)</timestamp>\n<user_query>\nRead a.txt then fix b.txt\n</user_query>" }] }),
    json({ role: "assistant", content: [{ type: "reasoning", text: "", signature: "x" }, { type: "tool-call", toolCallId: "call-1\nfc_1", toolName: "Read", args: { path: cwd + "/a.txt" } }, { type: "tool-call", toolCallId: "toolu_2", toolName: "Shell", args: { command: "false", description: "fail" } }], id: "1" }),
    json({ role: "tool", content: [{ type: "tool-result", toolCallId: "call-1\nfc_1", toolName: "Read", result: "hello\n" }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { content: "hello\n" } }, isError: false } } } }),
    json({ role: "tool", content: [{ type: "tool-result", toolCallId: "toolu_2", toolName: "Shell", result: "Exit code: 1" }], providerOptions: { cursor: { highLevelToolCallResult: { output: { failure: { exitCode: 1 } }, isError: false } } } }),
    json({ role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_3", toolName: "StrReplace", args: { path: cwd + "/b.txt", old_string: "bye", new_string: "ciao" } }], id: "1" }),
    json({ role: "tool", content: [{ type: "tool-result", toolCallId: "toolu_3", toolName: "StrReplace", result: "The file has been updated." }] }),
    json({ role: "assistant", content: [{ type: "text", text: "done" }], id: "1" }),
  ];
  const userMsg = put(pb([[1, "Read a.txt then fix b.txt"], [2, "2f2f6aff-a57a-4f3a-bff2-e4ab3351a1cd"], [25, 1791735162563]]));
  const step = (f) => put(pb(f));
  const steps = [
    step([[3, pb([[1, "Reading first."], [2, 5], [3, 1791735164678]])]]),
    step([[2, pb([[8, pb([[1, pb([[1, cwd + "/a.txt"]])]])], [57, "call-1\nfc_1"], [59, 1791735164688], [60, 1791735166308]])]]),
    step([[2, pb([[1, pb([[1, pb([[1, "false"]])], [2, pb([[2, pb([[3, 1], [5, ""]])]])]])], [57, "toolu_2"], [59, 1791735164693], [60, 1791735166219]])]]),
    /* a call whose JSON message was lost: decoded from the protobuf */
    step([[2, pb([[13, pb([[1, pb([[1, cwd]])], [2, pb([[1, pb([])]])]])], [57, "toolu_lost"], [59, 1791735166400], [60, 1791735166500]])]]),
    step([[2, pb([[12, pb([[1, pb([[1, cwd + "/b.txt"], [6, "ciao"]])]])], [57, "toolu_3"], [59, 1791735167458], [60, 1791735168805]])]]),
    step([[1, pb([[1, "done"], [2, 1791735169861]])]]),
  ];
  const turn = put(pb([[1, pb([[1, userMsg], ...steps.map((s) => [2, s]), [7, "Claude Opus"], [10, "2f2f6aff-a57a-4f3a-bff2-e4ab3351a1cd"]])]]));
  const shellTurn = put(pb([[2, pb([[1, put(pb([[1, "ls"]]))], [2, put(pb([[1, "a.txt\nb.txt\n"], [3, 0]]))]])]]));
  const root = put(pb([...msgs.map((m) => [1, m]), [5, pb([[1, 19753], [2, 256000]])], [8, turn], [8, shellTurn], [9, "file://" + cwd], [26, 1791735162480]]));
  const meta = { agentId: id, latestRootBlobId: Buffer.from(root).toString("hex"), name: "New Agent", mode: "default", createdAt: 1791735150665, lastUsedModel: "default" };
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", Buffer.from(JSON.stringify(meta)).toString("hex"));
  db.close();
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: 1791735150665, hasConversation: true, updatedAtMs: 1791735170240, cwd }));
  /* an unused chat (create-chat) is hidden from list() */
  const empty = path.join(base, "chats", "0".repeat(32), "11111111-1111-1111-1111-111111111111");
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: 1, hasConversation: false, updatedAtMs: 1 }));
  return dir;
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "cui-cursor-fixture-"));
const fixtureCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cui-cursor-cwd-"));
const CHAT = "df31f1e6-8ebc-4613-b59b-0b0b14a56fa7";
const realConfig = process.env.CURSOR_CONFIG_DIR;
buildStore(fixture, CHAT, fixtureCwd);
const { default: cursor } = await load("cursor.ts");

await test("store -> entries (turns + JSON messages)", async () => {
  process.env.CURSOR_CONFIG_DIR = fixture;
  const page = await cursor.history(CHAT, null);
  const e = page.entries;
  const kinds = e.map((x) => x.kind).join(",");
  assert.equal(kinds, "user,thinking,tool,result,tool,result,tool,result,tool,result,text,tool,result,usage");
  assert.equal(new Set(e.map((x) => x.id)).size, e.length, "ids unique");
  assert.equal(e[0].text, "Read a.txt then fix b.txt");
  assert.equal(e[0].ts, new Date(1791735162563).toISOString());
  assert.equal(e[1].text, "Reading first.");
  assert.deepEqual([e[2].name, e[2].input], ["Read", { file_path: fixtureCwd + "/a.txt" }]);
  assert.equal(e[2].toolUseId, "call-1~fc_1");
  assert.equal(e[3].toolUseId, "call-1~fc_1");
  assert.deepEqual(e[3].result, { text: "hello\n", isError: false, truncated: false });
  assert.deepEqual([e[4].name, e[4].input], ["Bash", { command: "false", description: "fail" }]);
  assert.equal(e[5].result.isError, true, "non-zero exit is an error");
  assert.deepEqual([e[6].name, e[6].input], ["LS", { path: fixtureCwd }], "protobuf fallback");
  assert.equal(e[7].result.isError, false);
  assert.deepEqual([e[8].name, e[8].input], ["Edit", { file_path: fixtureCwd + "/b.txt", old_string: "bye", new_string: "ciao" }]);
  assert.equal(e[10].text, "done");
  assert.deepEqual([e[11].name, e[11].input], ["Bash", { command: "ls" }], "shell turn");
  assert.equal(e[12].result.text, "a.txt\nb.txt\n");
  assert.deepEqual([e[13].model, e[13].input], ["Claude Opus", 19753]);
  assert.equal(page.end, String(e.length));
  assert.equal(page.cursor, null);
});

await test("list/get on the store", async () => {
  process.env.CURSOR_CONFIG_DIR = fixture;
  const all = await cursor.list();
  assert.deepEqual(all.map((s) => s.id), [CHAT], "hidden: chats without a conversation");
  assert.equal(all[0].cwd, fixtureCwd);
  assert.equal(all[0].title, "Read a.txt then fix b.txt", "title from the first prompt when meta has none");
  assert.ok(all[0].size > 0);
  assert.equal((await cursor.get(CHAT)).id, CHAT);
  assert.equal(await cursor.get("00000000-0000-0000-0000-000000000000"), null);
});

await test("watch sends nothing already in history, then new entries", async () => {
  process.env.CURSOR_CONFIG_DIR = fixture;
  const page = await cursor.history(CHAT, null);
  const got = [];
  const stop = cursor.watch(CHAT, page.end, (entries, end) => got.push({ entries, end }));
  await new Promise((r) => setTimeout(r, 300));
  stop();
  const ids = got.flatMap((g) => g.entries.map((e) => e.kind));
  assert.ok(ids.every((k) => k === "result"), `only results are re-sent on connect, got ${ids}`);
  const got2 = [];
  const stop2 = cursor.watch(CHAT, "2", (entries) => got2.push(...entries));
  await new Promise((r) => setTimeout(r, 300));
  stop2();
  assert.equal(got2.filter((e) => e.kind !== "result").length, page.entries.filter((e) => e.kind !== "result").length - 2);
});

await test("liveProcesses() returns a map", async () => {
  const m = await cursor.liveProcesses();
  assert.ok(m instanceof Map);
  console.log(`     live interactive cursor-agent chats: ${JSON.stringify([...m])}`);
});

if (realConfig === undefined) delete process.env.CURSOR_CONFIG_DIR;
else process.env.CURSOR_CONFIG_DIR = realConfig;
fs.rmSync(fixture, { recursive: true, force: true });

/* ── 3. the real CLI ──────────────────────────────────────── */

await test("binary()", async () => {
  const bin = await cursor.binary();
  console.log(`     binary: ${bin}`);
});

if (live) {
  await test("list() on the real ~/.cursor", async () => {
    const all = await cursor.list();
    console.log(`     ${all.length} chats`);
    for (const s of all.slice(0, 5)) console.log(`     - ${s.id} ${JSON.stringify(s.title)} cwd=${s.cwd} model=${s.model} size=${s.size}`);
    if (all[0]) {
      const page = await cursor.history(all[0].id, null);
      const counts = {};
      for (const e of page.entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      console.log(`     newest chat history: ${JSON.stringify(counts)} end=${page.end}`);
      for (const e of page.entries.slice(0, 12)) console.log(`       ${e.kind.padEnd(8)} ${e.id.slice(0, 40).padEnd(40)} ${e.kind === "tool" ? `${e.name} ${JSON.stringify(e.input).slice(0, 80)}` : e.kind === "result" ? JSON.stringify(e.result.text.slice(0, 60)) : JSON.stringify((e.text ?? "").slice(0, 70))}`);
    }
  });
}

if (startCwd) {
  await test(`start() in ${startCwd}`, async () => {
    fs.mkdirSync(startCwd, { recursive: true });
    const t0 = Date.now();
    try {
      const { id } = await cursor.start({ cwd: startCwd, text: "Reply with the single word: pong", mode: "default" });
      console.log(`     started chat ${id}; waiting for the turn...`);
      while (cursor.runState(id)?.status === "running") await new Promise((r) => setTimeout(r, 500));
      console.log(`     runState: ${JSON.stringify(cursor.runState(id))}`);
      const page = await cursor.history(id, null);
      console.log(`     history: ${page.entries.map((e) => `${e.kind}:${JSON.stringify((e.text ?? e.name ?? "").slice(0, 40))}`).join(" ")}`);
    } catch (err) {
      console.log(`     start() rejected after ${Date.now() - t0}ms: ${err.message}`);
      assert.match(err.message, /log(ged)? ?in|Authentication/i);
    }
  });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
