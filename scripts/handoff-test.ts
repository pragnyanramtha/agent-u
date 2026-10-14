/* Moves a real session to another agent and asks a question only the moved history can answer.
 *
 *   node --experimental-strip-types scripts/handoff-test.ts <sessionKey> <profileId> "<question>"
 *   e.g. kimi:session_… codex "What file did you create earlier? Reply with just its name."
 */
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(path.join(root, specifier.slice(2))).href;
    try {
      return next(specifier, context);
    } catch (err) {
      if (!(/^\.\.?\//.test(specifier) || specifier.startsWith("file:")) || /\.[cm]?[jt]s$/.test(specifier)) throw err;
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(`${specifier}/index.ts`, context);
      }
    }
  },
});

const [key, profileId, question] = process.argv.slice(2);
const { loadSource, handoff } = await import("../lib/server/handoff.ts");
const { getProfile } = await import("../lib/server/profiles.ts");
const { adapterFor, parseSessionKey } = await import("../lib/server/agents/index.ts");
const { getRun } = await import("../lib/server/runner.ts");

const src = await loadSource(key);
if (!src) throw new Error(`no session ${key}`);
console.log("source", src.agent, src.title, src.cwd, src.entries.length, "entries");
const profile = getProfile(profileId);
if (!profile) throw new Error(`no profile ${profileId}`);
const t0 = Date.now();
const next = await handoff(src, { text: question, mode: "default", profile });
console.log("new session", next, `${Date.now() - t0}ms`);
const k = parseSessionKey(next)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (k.agent === "claude") {
  const run = getRun(k.native);
  for (let i = 0; i < 240 && run && (run.state.status === "running" || run.state.status === "starting"); i++) await sleep(500);
  console.log("run", run?.state.status, run?.state.error);
  const { sessionContext } = await import("../lib/server/http.ts");
  const { readHistory } = await import("../lib/server/transcript.ts");
  const ctx = await sessionContext(k.native);
  const page = ctx ? await readHistory(ctx.file) : { entries: [] };
  for (const e of page.entries.slice(-3)) console.log(" ", e.kind, "text" in e ? JSON.stringify(String(e.text).slice(0, 200)) : "");
  run?.close();
} else {
  const a = (await adapterFor(k.agent))!;
  for (let i = 0; i < 240; i++) {
    const st = a.runState(k.native);
    if (st && st.status !== "running") break;
    await sleep(500);
  }
  console.log("run", a.runState(k.native));
  await sleep(1500);
  const page = await a.history(k.native, null);
  for (const e of page.entries.slice(-3)) console.log(" ", e.kind, "text" in e ? JSON.stringify(String(e.text).slice(0, 200)) : "");
}
process.exit(0);
