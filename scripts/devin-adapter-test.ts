/* Manual check of the Devin adapter against the real local store (read-only unless you ask it to start/send).
 *
 *   node --experimental-strip-types scripts/devin-adapter-test.ts            # binary, list, last entries, paging, live
 *   node --experimental-strip-types scripts/devin-adapter-test.ts history <id> [n]
 *   node --experimental-strip-types scripts/devin-adapter-test.ts watch <id> [seconds]
 *   node --experimental-strip-types scripts/devin-adapter-test.ts start <cwd> <text> [mode]   # spawns `devin -p`
 *   node --experimental-strip-types scripts/devin-adapter-test.ts send <id> <text> [mode]
 */
import { registerHooks } from "node:module";

/* the app imports siblings without extensions (bundler resolution); teach Node to try ".ts" */
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const { default: devin } = await import("../lib/server/agents/devin.ts");
type Entry = Awaited<ReturnType<typeof devin.history>>["entries"][number];

const one = (e: Entry): string => {
  const cut = (v: string, n = 110) => v.replace(/\s+/g, " ").slice(0, n);
  switch (e.kind) {
    case "user":
      return `USER     ${cut(e.text)}${e.images ? ` [+${e.images} img]` : ""}`;
    case "text":
      return `TEXT     ${cut(e.text)}`;
    case "thinking":
      return `THINK    ${cut(e.text)}`;
    case "tool":
      return `TOOL     ${e.name} ${cut(JSON.stringify(e.input), 100)}  (${e.toolUseId.slice(-8)})`;
    case "result":
      return `RESULT   ${e.result.isError ? "ERR " : ""}${e.result.truncated ? "TRUNC " : ""}${cut(e.result.text, 90)}  (${e.toolUseId.slice(-8)})`;
    case "usage":
      return `USAGE    ${e.model} in=${e.input} cr=${e.cacheRead} cw=${e.cacheWrite} out=${e.output}`;
    case "notice":
      return `NOTICE   ${e.text}`;
  }
};

async function showHistory(id: string, n = 20) {
  const page = await devin.history(id, null);
  console.log(`\n=== ${id}: ${page.entries.length} entries in last page, cursor=${page.cursor}, end=${page.end}`);
  for (const e of page.entries.slice(-n)) console.log("  " + one(e));
}

async function walkPages(id: string) {
  const t = Date.now();
  let page = await devin.history(id, null);
  let total = page.entries.length;
  let pages = 1;
  const ids = new Set(page.entries.map((e) => e.id));
  const kinds: Record<string, number> = {};
  const tools: Record<string, number> = {};
  const count = (es: Entry[]) => es.forEach((e) => ((kinds[e.kind] = (kinds[e.kind] ?? 0) + 1), e.kind === "tool" && (tools[e.name] = (tools[e.name] ?? 0) + 1)));
  count(page.entries);
  let dup = 0;
  while (page.cursor) {
    page = await devin.history(id, page.cursor);
    pages++;
    total += page.entries.length;
    count(page.entries);
    for (const e of page.entries) ids.has(e.id) ? dup++ : ids.add(e.id);
  }
  const toolUses = new Set<string>();
  const results = new Set<string>();
  // orphan check over the whole history
  let p = await devin.history(id, null);
  const all: Entry[] = [...p.entries];
  while (p.cursor) {
    p = await devin.history(id, p.cursor);
    all.unshift(...p.entries);
  }
  for (const e of all) e.kind === "tool" ? toolUses.add(e.toolUseId) : e.kind === "result" && results.add(e.toolUseId);
  const orphans = [...results].filter((r) => !toolUses.has(r)).length;
  console.log(`  pages=${pages} entries=${total} duplicateIds=${dup} orphanResults=${orphans} (${Date.now() - t}ms)`);
  console.log(`  kinds=${JSON.stringify(kinds)}`);
  console.log(`  tools=${JSON.stringify(tools)}`);
}

const [cmd, a1, a2, a3] = process.argv.slice(2);

if (!cmd) {
  console.log("binary:", await devin.binary());
  const list = await devin.list();
  console.log(`list: ${list.length} sessions`);
  for (const s of list.slice(0, 8)) console.log(`  ${s.id.padEnd(24)} ${new Date(s.mtime).toISOString()} ${s.model} ${s.cwd}  "${s.title.slice(0, 50)}"`);
  console.log("get(first):", JSON.stringify(await devin.get(list[0]?.id ?? "")));
  console.log("get(missing):", await devin.get("no-such-session"));
  const picks = list.slice(0, 3).map((s) => s.id);
  const big = [...list].find((s) => !picks.includes(s.id) && s.id === "loud-atlasaurus");
  if (big) picks.push(big.id);
  for (const id of picks) {
    await showHistory(id, 20);
    await walkPages(id);
  }
  console.log("\nliveProcesses:", Object.fromEntries(await devin.liveProcesses!()));
} else if (cmd === "history") {
  await showHistory(a1, Number(a2 ?? 20));
  await walkPages(a1);
} else if (cmd === "watch") {
  const { end } = await devin.history(a1, null);
  console.log(`watching ${a1} from ${end} for ${a2 ?? 30}s`);
  const off = devin.watch(a1, end, (entries, next) => {
    console.log(`+${entries.length} (end=${next})`);
    entries.forEach((e) => console.log("  " + one(e)));
  });
  setTimeout(() => (off(), process.exit(0)), Number(a2 ?? 30) * 1000);
} else if (cmd === "start" || cmd === "send") {
  const mode = (a3 ?? "default") as "default" | "acceptEdits" | "bypassPermissions" | "plan";
  let id = a1;
  try {
    if (cmd === "start") {
      console.log("binary:", await devin.binary());
      const t = Date.now();
      id = (await devin.start({ cwd: a1, text: a2, mode })).id;
      console.log(`started session ${id} in ${Date.now() - t}ms; runState:`, devin.runState(id));
    } else {
      await devin.send(id, a2, { mode });
      console.log("sent; runState:", devin.runState(id));
    }
  } catch (err) {
    console.log("FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const t0 = Date.now();
  while (devin.runState(id)?.status === "running" && Date.now() - t0 < 120_000) await new Promise((r) => setTimeout(r, 500));
  console.log("final runState:", devin.runState(id));
  await showHistory(id, 12);
  process.exit(0);
} else {
  console.log("unknown command");
}
