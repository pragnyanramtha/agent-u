import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "@/lib/types";
import { rekeyTurn, startTurn, stopTurn, turnState } from "./cli-run";
import { changedSince, getSession, historyPage, listSessions, sessionEnd, sessionsSince } from "./opencode-store";
import type { AgentAdapter, AgentSession, CliRunState, SendOptions, StartOptions } from "./types";

/* OpenCode (sst/opencode, >= 1.x). History comes read-only from its SQLite store
 * (see opencode-store.ts); web turns run `opencode run --format json` with the
 * prompt on stdin (positional args get re-quoted by the CLI), tracked by cli-run
 * under "opencode:<sessionId>". */

const POLL_MS = 1000;
/** re-read this far behind the watermark: rows are stamped before their transaction commits */
const SLACK_MS = 5000;
const START_TIMEOUT_MS = 60_000;

/** error text from the JSON stream ({"type":"error"}), which is better than stderr's last line */
const turnErrors = (() => {
  const g = globalThis as typeof globalThis & { __opencodeTurnErrors?: Map<string, string> };
  return (g.__opencodeTurnErrors ??= new Map());
})();

const keyOf = (id: string) => `opencode:${id}`;

let binCache: { path: string | null; at: number } | null = null;

async function binary(): Promise<string | null> {
  if (binCache && Date.now() - binCache.at < 30_000) return binCache.path;
  const home = os.homedir();
  const dirs = [
    ...(process.env.OPENCODE_BIN ? [path.dirname(process.env.OPENCODE_BIN)] : []),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  const names = process.env.OPENCODE_BIN ? [path.basename(process.env.OPENCODE_BIN)] : ["opencode"];
  let found: string | null = null;
  outer: for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) {
          found = p;
          break outer;
        }
      } catch {}
    }
  }
  binCache = { path: found, at: Date.now() };
  return found;
}

const toSession = (s: { id: string; title: string; directory: string; time_updated: number; model: string | null }): AgentSession => ({
  id: s.id,
  title: s.title.replace(/^New session - \d{4}-\d\d-\d\dT[\d:.]+Z$/, "") || "",
  cwd: s.directory,
  mtime: s.time_updated,
  size: 0,
  model: s.model,
});

function runArgs(opts: SendOptions): string[] {
  // ERROR logs on stderr: the JSON error event often only says "Unexpected server error" plus a ref into them
  const args = ["run", "--format", "json", "--print-logs", "--log-level", "ERROR"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.mode === "plan") args.push("--agent", "plan");
  // `opencode run` auto-rejects anything the agent's permissions mark "ask"; --auto approves it instead
  if (opts.mode === "bypassPermissions") args.push("--auto");
  return args;
}

/** Spawns one turn; `onSession` sees the session id from the first JSON event. */
async function spawnTurn(key: string, cwd: string, text: string, opts: SendOptions, extra: string[], onSession?: (id: string) => void) {
  const bin = await binary();
  if (!bin) throw new Error("OpenCode isn't installed (no `opencode` binary found).");
  let current = key;
  turnErrors.delete(current);
  /** move the run (and any error seen so far) from the provisional key to the real session id */
  const adopt = (id: string) => {
    const next = keyOf(id);
    if (next === current) return;
    rekeyTurn(current, next);
    const err = turnErrors.get(current);
    turnErrors.delete(current);
    if (err) turnErrors.set(next, err);
    else turnErrors.delete(next);
    current = next;
  };
  let stderr = () => "";
  const raw: unknown[] = [];
  const run = startTurn(
    key,
    // PWD matters: `opencode run` resolves its project from $PWD before process.cwd()
    { cmd: bin, args: [...runArgs(opts), ...extra], cwd, env: { PWD: cwd }, stdin: text },
    (line) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof ev.sessionID === "string" && onSession) {
        adopt(ev.sessionID);
        onSession(ev.sessionID);
      }
      if (ev.type === "error") {
        raw.push(ev.error);
        turnErrors.set(current, raw.map((e) => describeError(e, stderr())).join("\n"));
      }
    },
  );
  stderr = () => run.stderr;
  // stderr and stdout race: resolve log refs again once both pipes are drained
  run.child.on("close", () => {
    if (raw.length) turnErrors.set(current, raw.map((e) => describeError(e, run.stderr)).join("\n"));
  });
  return { run, key: () => current, adopt };
}

/** Readable text for a JSON `error` event, resolving `data.ref` against the ERROR log lines on stderr. */
function describeError(raw: unknown, stderr: string): string {
  const e = (raw ?? {}) as { name?: string; data?: { message?: string; ref?: string } };
  let msg = e.data?.message || e.name || "OpenCode reported an error";
  const ref = e.data?.ref;
  if (ref) {
    const m = new RegExp(`ref=${ref.replace(/[^\w-]/g, "")} error="((?:[^"\\\\]|\\\\.)*)"`).exec(stderr);
    if (m) msg = m[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
  }
  const kind = `${e.name ?? ""} ${/^(\w+Error): /.exec(msg)?.[1] ?? ""}`;
  msg = msg.replace(/^\w+Error: /, "");
  if (/ProviderModelNotFound/.test(kind) || /model not found/i.test(msg))
    return `${msg} (log in to that provider with \`opencode auth login\` on the host, or pick a model from \`opencode models\`)`;
  if (/ProviderAuthError/.test(kind) || /api key|unauthori[sz]ed|credential|401/i.test(msg)) return `${msg} (run \`opencode auth login\` on the host)`;
  return msg;
}

const adapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  binary,

  async list() {
    return listSessions().map(toSession);
  },

  async get(id) {
    const s = getSession(id);
    return s ? toSession(s) : null;
  },

  async history(id, before) {
    const end = sessionEnd(id);
    const page = historyPage(id, before);
    return { entries: page.entries, cursor: page.cursor, end: String(end || Date.now()) };
  },

  watch(id, from, onEntries) {
    let mark = Number(from);
    if (!Number.isFinite(mark) || mark <= 0) mark = Date.now();
    const sent = new Set<string>();
    let busy = false;
    let closed = false;
    const tick = () => {
      if (busy || closed) return;
      busy = true;
      try {
        const { entries, end } = changedSince(id, mark - SLACK_MS);
        // results can repeat harmlessly (the UI replaces them by tool id); everything else once per id
        const fresh = entries.filter((e: Entry) => {
          const k = e.kind === "result" ? `r:${e.id}` : e.id;
          if (sent.has(k)) return false;
          sent.add(k);
          return true;
        });
        const changed = end > mark;
        if (changed) mark = end;
        if (fresh.length || changed) onEntries(fresh, String(mark));
      } catch {
        // locked or mid-migration database: try again next tick
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(tick, POLL_MS);
    tick();
    return () => {
      closed = true;
      clearInterval(timer);
    };
  },

  async liveProcesses() {
    return liveTuis();
  },

  async start(opts: StartOptions) {
    const startedAt = Date.now();
    const pending = keyOf(`new-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    return new Promise<{ id: string }>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = (err: Error | null, id?: string) => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        if (err) reject(err);
        else resolve({ id: id! });
      };
      spawnTurn(pending, opts.cwd, opts.text, opts, [], (id) => finish(null, id))
        .then(({ run, key, adopt }) => {
          // the session row appears before the model answers; match it by its first prompt to resolve early
          const want = opts.text.trim();
          timer = setInterval(() => {
            if (done) return;
            try {
              const hit = sessionsSince(startedAt - 2000).find((s) => s.firstText.trim() === want);
              if (hit) {
                adopt(hit.id);
                finish(null, hit.id);
                return;
              }
            } catch {}
            if (Date.now() - startedAt > START_TIMEOUT_MS) {
              stopTurn(key());
              finish(new Error("OpenCode didn't start a session within a minute."));
            }
          }, 400);
          run.child.on("exit", () => {
            // give the stdout tail a moment to deliver the session id
            setTimeout(() => {
              const k = key();
              const st = turnState(k);
              finish(new Error(turnErrors.get(k) || st?.error || "OpenCode exited before starting a session."));
            }, 300);
          });
          run.child.on("error", (err) => finish(err));
        })
        .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  },

  async send(id, text, opts) {
    const s = getSession(id);
    if (!s) throw new Error("OpenCode session not found.");
    const cwd = s.directory && fs.existsSync(s.directory) ? s.directory : os.homedir();
    await spawnTurn(keyOf(id), cwd, text, opts, ["--session", id]);
  },

  runState(id): CliRunState | null {
    const key = keyOf(id);
    const s = turnState(key);
    if (!s) return null;
    const err = turnErrors.get(key);
    return s.status === "error" && err ? { ...s, error: err } : s;
  },

  async stop(id) {
    stopTurn(keyOf(id));
  },
};

export default adapter;

/* ── interactive TUIs ────────────────────────────────────── */

const NOT_TUI = new Set([
  "run", "serve", "web", "acp", "mcp", "debug", "models", "auth", "providers", "session", "export", "import",
  "stats", "upgrade", "uninstall", "agent", "db", "github", "plugin", "plug", "completion", "attach",
]);

/** Running `opencode` TUIs, each mapped to its session: `-s <id>` if given, else the newest session in its folder since it started. */
async function liveTuis(): Promise<Map<string, { pid: number }>> {
  const out = new Map<string, { pid: number }>();
  if (process.platform !== "linux") return out;
  let pids: string[];
  try {
    pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }
  const procs: { pid: number; ppid: number; argv: string[] }[] = [];
  for (const d of pids) {
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!argv.length) continue;
      const i = argv.findIndex((a, n) => n < 2 && path.basename(a) === "opencode");
      if (i === -1) continue;
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      procs.push({ pid: Number(d), ppid, argv: argv.slice(i + 1) });
    } catch {}
  }
  const ours = new Set(procs.map((p) => p.pid));
  const btime = bootTime();
  const sessions = procs.length ? listSessions(200) : [];
  for (const p of procs) {
    if (ours.has(p.ppid)) continue; // a worker of another opencode process
    const positional = positionals(p.argv);
    if (positional[0] && NOT_TUI.has(positional[0])) continue;
    const si = p.argv.findIndex((a) => a === "-s" || a === "--session");
    const explicit = si !== -1 ? p.argv[si + 1] : p.argv.find((a) => a.startsWith("--session="))?.slice(10);
    if (explicit) {
      out.set(explicit, { pid: p.pid });
      continue;
    }
    let cwd: string;
    try {
      cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`);
    } catch {
      continue;
    }
    if (positional[0]) cwd = path.resolve(cwd, positional[0]);
    const started = btime ? processStart(p.pid, btime) : 0;
    const hit = sessions.find((s) => s.directory === cwd && s.time_updated >= started && !out.has(s.id));
    if (hit) out.set(hit.id, { pid: p.pid });
  }
  return out;
}

function positionals(argv: string[]): string[] {
  const out: string[] = [];
  const valued = new Set(["-m", "--model", "-s", "--session", "--prompt", "--agent", "--port", "--hostname", "--log-level", "--mdns-domain", "--cors", "--replay-limit"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

function bootTime(): number {
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    return m ? Number(m[1]) * 1000 : 0;
  } catch {
    return 0;
  }
}

function processStart(pid: number, btime: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    return btime + (ticks * 1000) / 100;
  } catch {
    return 0;
  }
}
