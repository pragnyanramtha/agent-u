/* Smoke test for the Codex adapter against real ~/.codex data.
 *
 *   node --experimental-strip-types scripts/codex-adapter-test.ts [--live] [session-id ...]
 *
 * Lists sessions, prints the tail of a few transcripts, and with --live runs one
 * real `codex exec` turn in /tmp/cui-vm-test plus one resume. Extensionless
 * relative imports are resolved to .ts by a tiny loader hook registered below. */
import { register } from "node:module";
import fs from "node:fs/promises";
import type { Entry } from "@/lib/types";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (err) {
    if ((spec.startsWith(".") || spec.startsWith("/")) && !/\\.[cm]?[jt]s$/.test(spec)) return next(spec + ".ts", ctx);
    throw err;
  }
}`),
);

const { default: codex } = (await import("../lib/server/agents/codex" + "")) as typeof import("../lib/server/agents/codex");
const { onTurn } = (await import("../lib/server/agents/cli-run" + "")) as typeof import("../lib/server/agents/cli-run");

const argv = process.argv.slice(2);
const live = argv.includes("--live");
const ids = argv.filter((a) => !a.startsWith("--"));

const show = (e: Entry) => {
  const one = (s: string, n = 140) => s.replace(/\s+/g, " ").slice(0, n);
  switch (e.kind) {
    case "user":
      return `user     ${one(e.text)}${e.images ? ` [+${e.images} img]` : ""}`;
    case "text":
      return `text     ${one(e.text)}`;
    case "thinking":
      return `thinking ${one(e.text)}`;
    case "tool":
      return `tool     ${e.name} ${e.toolUseId.slice(0, 14)} ${one(JSON.stringify(e.input), 160)}`;
    case "result":
      return `result   ${e.toolUseId.slice(0, 14)} err=${e.result.isError} trunc=${e.result.truncated} ${one(e.result.text, 120)}`;
    case "notice":
      return `notice   [${e.tone}] ${one(e.text)}`;
    case "usage":
      return `usage    ${e.model} in=${e.input} cache=${e.cacheRead} out=${e.output}`;
  }
};

console.log("binary:", await codex.binary());
let t = Date.now();
const sessions = await codex.list();
console.log(`list: ${sessions.length} sessions in ${Date.now() - t}ms`);
for (const s of sessions.slice(0, 12)) console.log(`  ${s.id}  ${new Date(s.mtime).toISOString()}  ${String(s.size).padStart(8)}  ${s.model ?? "-"}  ${s.cwd}  | ${s.title}`);
t = Date.now();
await codex.list();
console.log(`list (cached): ${Date.now() - t}ms`);
console.log("live terminals:", [...(await codex.liveProcesses!()).entries()]);

const pick = ids.length ? ids : sessions.slice(0, 2).map((s) => s.id);
for (const id of pick) {
  const page = await codex.history(id, null);
  const seen = new Set<string>();
  const dup = page.entries.filter((e) => (seen.has(e.id) ? true : (seen.add(e.id), false)));
  const kinds = page.entries.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
  console.log(`\n=== ${id}: ${page.entries.length} entries, cursor=${page.cursor} end=${page.end} dupIds=${dup.length}`, kinds);
  for (const e of page.entries.slice(-20)) console.log("  " + show(e));
  /* page all the way back: ids stay unique, cursors strictly decrease */
  let cursor = page.cursor;
  let pages = 1;
  let total = page.entries.length;
  while (cursor) {
    const prev = await codex.history(id, cursor);
    for (const e of prev.entries) if (seen.has(e.id)) dup.push(e);
    else seen.add(e.id);
    if (prev.cursor && Number(prev.cursor) >= Number(cursor)) throw new Error("cursor did not move back");
    cursor = prev.cursor;
    total += prev.entries.length;
    pages++;
  }
  const tools = [...seen].length;
  console.log(`  paged: ${pages} pages, ${total} entries, ${tools} unique ids, dup ids across pages: ${dup.length}`);
}

if (live) {
  const cwd = "/tmp/cui-vm-test";
  await fs.mkdir(cwd, { recursive: true });
  const waitIdle = (id: string) =>
    new Promise<void>((resolve) => {
      const check = () => {
        const st = codex.runState(id);
        if (st && st.status !== "running") {
          off();
          resolve();
        }
      };
      const off = onTurn(`codex:${id}`, check);
      check();
    });

  console.log("\n=== live start()");
  t = Date.now();
  const { id } = await codex.start({ cwd, text: "Reply with exactly: ok", mode: "default" });
  console.log(`started ${id} in ${Date.now() - t}ms, state:`, codex.runState(id));
  const startPage = await codex.history(id, null);
  const got: Entry[] = [];
  const unwatch = codex.watch(id, startPage.end, (entries) => got.push(...entries));
  await waitIdle(id);
  await new Promise((r) => setTimeout(r, 2500));
  console.log("after turn:", codex.runState(id));
  console.log(`watch delivered ${got.length} entries:`);
  for (const e of got) console.log("  " + show(e));

  console.log("\n=== live send() resume");
  got.length = 0;
  await codex.send(id, "Now reply with exactly: ok again", { mode: "plan" });
  console.log("state:", codex.runState(id));
  await waitIdle(id);
  await new Promise((r) => setTimeout(r, 2500));
  unwatch();
  console.log("after resume:", codex.runState(id));
  for (const e of got) console.log("  " + show(e));
  const full = await codex.history(id, null);
  console.log(`history now: ${full.entries.length} entries`);
  for (const e of full.entries) console.log("  " + show(e));
  console.log("get:", await codex.get(id));

  console.log("\n=== live error surfacing (unsupported model)");
  try {
    const bad = await codex.start({ cwd, text: "Reply with exactly: ok", model: "gpt-6.1-luna", mode: "plan" });
    await waitIdle(bad.id);
    console.log("bad model state:", codex.runState(bad.id));
  } catch (err) {
    console.log("start rejected:", (err as Error).message);
  }
}
process.exit(0);
