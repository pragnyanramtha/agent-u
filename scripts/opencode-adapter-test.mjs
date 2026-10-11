#!/usr/bin/env node
/* Smoke test for lib/server/agents/opencode.ts outside Next.
 *
 *   node --experimental-strip-types scripts/opencode-adapter-test.mjs [agentsDir] [--drive]
 *
 * agentsDir defaults to ../lib/server/agents. Lists sessions, prints the last
 * entries of the newest two, and with --drive starts one session in
 * /tmp/cui-vm-test ("Reply with exactly: ok"), sends one follow-up and prints
 * the run state and the live entries the watcher delivered. Set OC_MODEL to
 * pass --model. */
import { registerHooks } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// adapter files use extensionless relative imports (Next/TS style); resolve them to .ts here
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (err) {
      if (spec.startsWith(".") && !path.extname(spec)) return next(spec + ".ts", ctx);
      throw err;
    }
  },
});

const args = process.argv.slice(2);
const drive = args.includes("--drive");
const dir = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../lib/server/agents"));
const { default: oc } = await import(pathToFileURL(path.join(dir, "opencode.ts")).href);

const short = (e) => {
  const body =
    e.kind === "tool" ? `${e.name} ${JSON.stringify(e.input).slice(0, 140)}`
    : e.kind === "result" ? `${e.result.isError ? "ERR " : ""}${JSON.stringify(e.result.text.slice(0, 120))}${e.result.truncated ? " (truncated)" : ""}`
    : e.kind === "usage" ? `${e.model} in=${e.input} cacheRead=${e.cacheRead} cacheWrite=${e.cacheWrite} out=${e.output}`
    : JSON.stringify((e.text ?? "").slice(0, 140));
  return `  ${e.ts.slice(11, 19)} ${e.kind.padEnd(8)} ${e.id.slice(0, 34).padEnd(34)} ${body}`;
};

console.log("binary:", await oc.binary());
const list = await oc.list();
console.log(`sessions: ${list.length}`);
for (const s of list.slice(0, 10)) console.log(`  ${s.id}  ${new Date(s.mtime).toISOString()}  ${s.cwd}  ${JSON.stringify(s.title)}  ${s.model ?? ""}`);
console.log("live TUIs:", [...(await oc.liveProcesses()).entries()]);

for (const s of list.slice(0, 2)) {
  const page = await oc.history(s.id, null);
  console.log(`\nhistory ${s.id}: ${page.entries.length} entries, cursor=${page.cursor}, end=${page.end}`);
  for (const e of page.entries.slice(-20)) console.log(short(e));
  if (page.cursor) {
    const older = await oc.history(s.id, page.cursor);
    console.log(`  older page: ${older.entries.length} entries, cursor=${older.cursor}`);
  }
}

if (drive) {
  const cwd = "/tmp/cui-vm-test";
  mkdirSync(cwd, { recursive: true });
  const model = process.env.OC_MODEL || undefined;
  const wait = async (id, label) => {
    for (let i = 0; i < 180; i++) {
      const st = oc.runState(id);
      if (st && st.status !== "running") return st;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return oc.runState(id);
  };
  console.log(`\nstart() in ${cwd}${model ? ` with ${model}` : ""}...`);
  const t0 = Date.now();
  let id;
  try {
    ({ id } = await oc.start({ cwd, text: "Reply with exactly: ok", model, mode: "default" }));
  } catch (err) {
    console.log("start failed:", err.message);
    process.exit(1);
  }
  console.log(`  session ${id} after ${Date.now() - t0}ms, runState:`, oc.runState(id));
  const live = [];
  const { end } = await oc.history(id, null);
  const unwatch = oc.watch(id, String(Number(end) - 10_000), (entries) => live.push(...entries));
  console.log("  finished:", await wait(id, "start"));
  console.log("\nsend()...");
  await oc.send(id, "Now reply with exactly: ok again", { model, mode: "default" });
  console.log("  runState after spawn:", oc.runState(id));
  console.log("  finished:", await wait(id, "send"));
  await new Promise((r) => setTimeout(r, 2500));
  unwatch();
  console.log(`\nwatch delivered ${live.length} entries:`);
  for (const e of live) console.log(short(e));
  const page = await oc.history(id, null);
  console.log(`\nhistory ${id}: ${page.entries.length} entries`);
  for (const e of page.entries) console.log(short(e));
}
process.exit(0);
