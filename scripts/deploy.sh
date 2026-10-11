#!/usr/bin/env bash
# Ships the committed code (git archive HEAD) to the server, installs, builds and restarts.
# Reads DEPLOY_SSH, DEPLOY_SSH_PORT and DEPLOY_DIR from .env.deploy (see .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.deploy ] || { echo "Missing .env.deploy (copy the Deploy section of .env.example)" >&2; exit 1; }
set -a; . ./.env.deploy; set +a
SSH=(ssh -p "${DEPLOY_SSH_PORT:-22}" -o BatchMode=yes "$DEPLOY_SSH")
DIR="${DEPLOY_DIR:-agent-u}"
case "$DIR" in /home/*|/Users/*) [ "$DIR" = "${DIR#$HOME}" ] || { echo "DEPLOY_DIR expanded to a local path ($DIR); use a path relative to the remote home" >&2; exit 1; } ;; esac

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "Note: uncommitted changes are not deployed." >&2; fi
git archive HEAD | "${SSH[@]}" "mkdir -p \"\$HOME/$DIR\" && cd \"\$HOME/$DIR\" && tar -x"
"${SSH[@]}" "export PATH=\$HOME/.local/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  cd \"\$HOME/$DIR\" && pnpm install --frozen-lockfile >/dev/null && pnpm build 2>&1 | grep -E 'Compiled|rror' ;
  systemctl --user restart agent-u agent-u-pty && sleep 3 && systemctl --user is-active agent-u agent-u-pty"
