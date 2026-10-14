/* Manual check of the Kimi adapter against the real local homes (read-only unless you ask it to start/send).
 *
 *   node --experimental-strip-types scripts/kimi-adapter-test.ts                    # binary, list, last entries, paging
 *   node --experimental-strip-types scripts/kimi-adapter-test.ts start <cwd> <text> # spawns `kimi --prompt` (KIMI_BIN=kmi for a wrapper)
 *   node --experimental-strip-types scripts/kimi-adapter-test.ts send <id> <text>
 */
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
/* the app imports siblings without extensions and "@/..." from the root (bundler resolution) */
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href;
    try {
      return next(specifier, context);
    } catch (err) {
      if ((/^\.\.?\//.test(specifier) || specifier.startsWith("file:")) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const { default: kimi } = await import("../lib/server/agents/kimi.ts");
const [cmd, a1, a2] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitTurn(id: string) {
  for (let i = 0; i < 240; i++) {
    const st = kimi.runState(id);
    if (st && st.status !== "running") return st;
    await sleep(500);
  }
  return kimi.runState(id);
}

if (cmd === "start" || cmd === "send") {
  let id = a1;
  if (cmd === "start") id = (await kimi.start({ cwd: a1, text: a2, mode: "default" })).id;
  else await kimi.send(id, a2, { mode: "default" });
  console.log("session", id);
  console.log("turn", await waitTurn(id));
  const page = await kimi.history(id, null);
  for (const e of page.entries.slice(-6)) console.log(e.kind, "text" in e ? String(e.text).slice(0, 80) : "name" in e ? e.name : "");
  process.exit(0);
}

console.log("binary", await kimi.binary());
const list = await kimi.list();
console.log("sessions", list.length);
for (const s of list.slice(0, 5)) console.log(" ", s.id, JSON.stringify(s.title), s.cwd, s.model, new Date(s.mtime).toISOString());
const first = list[0];
if (first) {
  const page = await kimi.history(first.id, null);
  console.log("entries", page.entries.length, "cursor", page.cursor, "end", page.end);
  const kinds: Record<string, number> = {};
  for (const e of page.entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log("kinds", kinds);
  for (const e of page.entries) console.log(" ", e.kind, "text" in e ? JSON.stringify(String(e.text).slice(0, 60)) : "name" in e ? `${e.name} ${JSON.stringify(e.input).slice(0, 80)}` : e.kind === "result" ? JSON.stringify(e.result.text.slice(0, 40)) : "");
  console.log("live", [...(await kimi.liveProcesses!()).entries()]);
}
