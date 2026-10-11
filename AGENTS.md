# agent-u

Self-hosted, mobile-friendly web UI for coding-agent CLI sessions running on a server (Claude Code first; Codex,
OpenCode, Cursor CLI and Devin CLI through adapters). Built on Beautiful UI (Next.js 15, React 19, Tailwind v4, pnpm).
Watch live sessions, type into the terminal they run in, start/resume sessions from the browser, and open a full web terminal.

## Commands
- `pnpm install` / `pnpm dev` (127.0.0.1:3311) / `pnpm build` / `pnpm start`
- `pnpm typecheck` before every commit
- `printf 'password\n' | node scripts/hash-password.mjs` prints a `UI_PASSWORD_HASH=` line
- `scripts/deploy.sh` ships the committed code (`git archive HEAD`) to the server, builds, restarts (reads `.env.deploy`)

## Configuration
All machine-specific values live in gitignored env files; `.env.example` documents every key.
- `.env.local` on the server (chmod 600): `UI_PASSWORD_HASH` (`scrypt:salt:hash`, colon-separated because Next's dotenv
  expands `$`), `UI_SECRET` (32+ chars, signs the session cookie), optional `CLAUDE_BIN`, `CLAUDE_HOME`, `HIDE_PROJECTS`,
  `IDLE_REAP_MS`, `PTY_PORT`.
- `.env.deploy` on your machine: `DEPLOY_SSH`, `DEPLOY_SSH_PORT`, `DEPLOY_DIR`, `PUBLIC_HOSTNAME`, `TUNNEL_NAME`.
- Never commit hostnames, IPs, ports, tunnel ids, passwords or keys.

## Server setup (once)
Requirements on the server: Node 22+ (24 recommended), pnpm, python3 (web terminal), the agent CLIs you use
(`claude`, `codex`, `opencode`, `cursor-agent`, `devin`), optionally zellij/tmux, and `cloudflared` for public access.
1. `scripts/deploy.sh` (copies code, installs, builds). First time, also create `.env.local` in `DEPLOY_DIR` from `.env.example`.
2. Install the user units from `deploy/` into `~/.config/systemd/user/`: `agent-u.service` (app on 127.0.0.1:3311),
   `agent-u-pty.service` (web terminal backend on 127.0.0.1:3312). `systemctl --user daemon-reload && systemctl --user enable --now agent-u agent-u-pty`.
   Run `loginctl enable-linger <user>` so user services survive logout and reboot.
3. Public URL: never expose the ports directly. Use a Cloudflare named tunnel (quick tunnels can't stream GET SSE):
   `cloudflared tunnel create $TUNNEL_NAME`, `cloudflared tunnel route dns $TUNNEL_NAME $PUBLIC_HOSTNAME`, copy the credentials
   JSON to the server's `~/.cloudflared/`, write `~/.cloudflared/agent-u.yml` from `deploy/cloudflared.example.yml`
   (routes `^/pty` to the terminal backend, everything else to the app), and enable `deploy/agent-u-tunnel.service`.
4. Agent logins happen on the server in a terminal (or the web terminal): `claude` (login), `codex login`,
   `opencode auth login`, `cursor-agent login`, `devin` login.

## Security model
- One password for everything; the site can open a shell on the server, so treat the password like an SSH key.
- Middleware gates every page and API route on the signed `cui_session` cookie (HttpOnly, SameSite=strict, Secure behind
  HTTPS); state-changing API calls also need a same-origin `Origin`. Login is rate limited per IP.
- The web terminal backend (`server/pty.mjs`) re-checks the cookie and origin on the WebSocket upgrade.
- Consider Cloudflare Access (email OTP) in front of the hostname for a second factor.

## Architecture notes
- Transcripts (`~/.claude/projects/*/*.jsonl`) are the source of truth for history; `lib/server/tail.ts` streams appends.
- Live terminal sessions come from `~/.claude/sessions/<pid>.json` (pid + start time checked).
- Web runs (`lib/server/runner.ts`, Claude Agent SDK) only add deltas, status, and approvals.
- One agent process per session, never a copy: `POST /api/sessions/[id]/message` routes to the live web run, else types into
  the zellij/tmux pane (`lib/server/input.ts`, checks Claude's prompt first: agent focus, unsent text, dialogs), else resumes.
- Live stream is `POST /api/sessions/[id]/events` read with fetch (SSE framing, `id:` = resume offset, 40s stall reconnect).
- Messages sent while Claude is mid-turn land in the transcript as `attachment` records (`queued_command`).
- Other agents: `lib/server/agents/<agent>.ts` implement `AgentAdapter` (`lib/server/agents/types.ts`) and emit the same
  `Entry` stream; session ids are `<agent>:<nativeId>` (plain ids are Claude, so old links keep working). Web-driven turns use
  each CLI's non-interactive mode via `lib/server/agents/cli-run.ts`. Route glue in `lib/server/agents/routes.ts`.
- Web terminal: `server/pty.mjs` runs a shell, or attaches to the session's zellij/tmux, on a pty via `server/pty_bridge.py`
  (no native Node module).
- UI copy: no em dashes; loading labels end with an ellipsis.
