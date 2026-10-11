/* Web terminal backend: a WebSocket on 127.0.0.1:3312/pty that runs a shell,
 * or attaches to the zellij/tmux session a Claude session lives in, on a
 * pseudo-terminal (server/pty_bridge.py). Cloudflare routes /pty here.
 * Same login as the app: the signed cui_session cookie and a same-origin check. */

import { spawn, execFileSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const PORT = Number(process.env.PTY_PORT ?? 3312);
const MAX_TERMINALS = 8;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* same .env.local the Next app reads */
for (const line of fs.readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SECRET = process.env.UI_SECRET ?? "";
if (SECRET.length < 32) throw new Error("UI_SECRET must be set to at least 32 characters");
const CLAUDE_HOME = process.env.CLAUDE_HOME ?? path.join(os.homedir(), ".claude");

function validCookie(header) {
  const raw = /(?:^|;\s*)cui_session=([^;]+)/.exec(header ?? "")?.[1];
  if (!raw) return false;
  const [expires, sig, extra] = decodeURIComponent(raw).split(".");
  if (!/^\d+$/.test(expires ?? "") || !sig || extra !== undefined || Number(expires) < Date.now()) return false;
  const want = createHmac("sha256", SECRET).update(expires).digest("base64url");
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

function sameOrigin(req) {
  try {
    const origin = new URL(req.headers.origin ?? "").host;
    const hosts = [req.headers.host, String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim()].filter(Boolean);
    return hosts.includes(origin);
  } catch {
    return false;
  }
}

const envOf = (pid, key) => {
  try {
    const m = new RegExp(`(?:^|\0)${key}=([^\0]*)`).exec(fs.readFileSync(`/proc/${pid}/environ`, "utf8"));
    return m?.[1] || null;
  } catch {
    return null;
  }
};
const ppidOf = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
};

/** Attach command for the zellij/tmux a process runs in (walking up its parents), or null. */
function attachForPid(start) {
  for (let pid = start, depth = 0; pid > 1 && depth < 6; pid = ppidOf(pid), depth++) {
    const zellij = envOf(pid, "ZELLIJ_SESSION_NAME");
    if (zellij) return ["zellij", "attach", zellij];
    const pane = envOf(pid, "TMUX_PANE");
    if (pane) {
      const name = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#S"], { encoding: "utf8" }).trim();
      return ["tmux", "attach-session", "-t", name];
    }
  }
  return null;
}

/** The multiplexer attach command for the terminal a Claude session is open in, or null. */
function attachCommand(sessionId) {
  const dir = path.join(CLAUDE_HOME, "sessions");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (info.sessionId !== sessionId || !fs.existsSync(`/proc/${info.pid}`)) continue;
    for (let pid = info.pid, depth = 0; pid > 1 && depth < 6; pid = ppidOf(pid), depth++) {
      const zellij = envOf(pid, "ZELLIJ_SESSION_NAME");
      if (zellij) return ["zellij", "attach", zellij];
      const pane = envOf(pid, "TMUX_PANE");
      if (pane) {
        const name = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#S"], { encoding: "utf8" }).trim();
        return ["tmux", "attach-session", "-t", name];
      }
    }
  }
  return null;
}

let open = 0;
const server = http.createServer((_req, res) => {
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://local");
  const refuse = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== "/pty") return refuse(404, "Not Found");
  if (!sameOrigin(req)) return refuse(403, "Bad Origin");
  if (!validCookie(req.headers.cookie)) return refuse(401, "Unauthorized");
  if (open >= MAX_TERMINALS) return refuse(429, "Too Many Terminals");
  wss.handleUpgrade(req, socket, head, (ws) => start(ws, url));
});

function start(ws, url) {
  const session = url.searchParams.get("session");
  const pid = Number(url.searchParams.get("pid"));
  const cols = Math.min(500, Math.max(10, Number(url.searchParams.get("cols")) || 100));
  const rows = Math.min(200, Math.max(5, Number(url.searchParams.get("rows")) || 30));
  let cmd;
  let cwd = os.homedir();
  if (Number.isInteger(pid) && pid > 1 && fs.existsSync(`/proc/${pid}`)) {
    cmd = attachForPid(pid);
    if (!cmd) {
      ws.close(4404, "That session isn't running in zellij or tmux.");
      return;
    }
  } else if (session) {
    cmd = SESSION_ID.test(session) ? attachCommand(session) : null;
    if (!cmd) {
      ws.close(4404, "That session isn't open in zellij or tmux.");
      return;
    }
  } else {
    const want = url.searchParams.get("cwd");
    if (want && path.isAbsolute(want) && fs.existsSync(want) && fs.statSync(want).isDirectory()) cwd = want;
    cmd = [process.env.SHELL || "/bin/bash", "-l"];
  }

  open++;
  const child = spawn("python3", [path.join(here, "pty_bridge.py"), ...cmd], {
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", PTY_COLS: String(cols), PTY_ROWS: String(rows) },
    stdio: ["pipe", "pipe", "ignore", "pipe"],
  });
  const ctl = child.stdio[3];
  child.stdin.on("error", () => undefined);
  ctl.on("error", () => undefined);

  child.stdout.on("data", (chunk) => ws.readyState === ws.OPEN && ws.send(chunk, { binary: true }));
  child.on("exit", () => ws.readyState === ws.OPEN && ws.close(1000, "exited"));
  child.on("error", () => ws.readyState === ws.OPEN && ws.close(1011, "couldn't start"));

  /* text frames are JSON control/input; Cloudflare drops idle sockets, so ping */
  ws.on("message", (raw, isBinary) => {
    if (isBinary) return child.stdin.write(raw);
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === "input" && typeof msg.data === "string") child.stdin.write(msg.data);
      else if (msg.type === "resize") ctl.write(`${Math.min(500, Math.max(10, msg.cols | 0))} ${Math.min(200, Math.max(5, msg.rows | 0))}\n`);
    } catch {
      /* ignore malformed frames */
    }
  });
  const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 25_000);
  ws.on("close", () => {
    clearInterval(ping);
    open--;
    child.stdin.end();
    setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2000).unref();
  });
}

server.listen(PORT, "127.0.0.1", () => console.log(`pty server on 127.0.0.1:${PORT}`));
