import { activeRuns } from "./runner";
import { runningTurns, stopTurn } from "./agents/cli-run";

/* Restarts (deploys) give running agent turns a moment to finish, then end them cleanly instead of
 * being SIGKILLed with the process group. Needs NEXT_MANUAL_SIG_HANDLE=1 (see deploy/agent-u.service):
 * Next's own handler waits for open requests, and live streams never finish. */

const GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installShutdown() {
  const g = globalThis as { __agentuShutdown?: boolean };
  if (g.__agentuShutdown || !process.env.NEXT_MANUAL_SIG_HANDLE) return;
  g.__agentuShutdown = true;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const until = Date.now() + GRACE_MS;
    const busy = () => activeRuns().filter((r) => r.state.status === "running" || r.state.status === "starting").length + runningTurns().length;
    if (busy()) console.log(`shutdown: waiting up to ${GRACE_MS / 1000}s for ${busy()} running turn(s)`);
    while (busy() && Date.now() < until) await sleep(500);
    for (const r of activeRuns()) r.close();
    for (const key of runningTurns()) stopTurn(key);
    await sleep(300);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
