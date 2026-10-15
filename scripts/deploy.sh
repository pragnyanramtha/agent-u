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
# the terminal backend holds open shells; restart it only when its own code changed
"${SSH[@]}" "set -o pipefail; export PATH=\$HOME/.local/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  cd \"\$HOME/$DIR\" || exit 1
  pnpm install --frozen-lockfile >/dev/null || { echo 'pnpm install failed; nothing restarted' >&2; exit 1; }
  pnpm build > .deploy-build.log 2>&1 || { tail -40 .deploy-build.log >&2; echo 'Build failed; the running app was left as is' >&2; exit 1; }
  grep -E 'Compiled' .deploy-build.log
  units=agent-u
  pty=\$(cat server/* package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [ \"\$pty\" != \"\$(cat .pty-hash 2>/dev/null)\" ] || ! systemctl --user is-active --quiet agent-u-pty; then units=\"agent-u agent-u-pty\"; fi
  systemctl --user restart \$units && echo \"\$pty\" > .pty-hash && sleep 3 && systemctl --user is-active \$units"
