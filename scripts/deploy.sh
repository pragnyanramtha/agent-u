#!/usr/bin/env bash
# Ships the committed code (git archive HEAD) to the server, installs, builds and restarts.
# Reads DEPLOY_SSH, DEPLOY_SSH_PORT and DEPLOY_DIR from .env.deploy (see .env.example).
#
# Each release is built in a fresh folder next to the live one, so the running app is never touched by a build
# and files deleted in git are gone from the server. The live folder is swapped in by rename; the old one stays
# as <dir>.prev, and comes back if the new release doesn't start.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.deploy ] || { echo "Missing .env.deploy (copy the Deploy section of .env.example)" >&2; exit 1; }
set -a; . ./.env.deploy; set +a
SSH=(ssh -p "${DEPLOY_SSH_PORT:-22}" -o BatchMode=yes "$DEPLOY_SSH")
DIR="${DEPLOY_DIR:-agent-u}"
case "$DIR" in /home/*|/Users/*) [ "$DIR" = "${DIR#$HOME}" ] || { echo "DEPLOY_DIR expanded to a local path ($DIR); use a path relative to the remote home" >&2; exit 1; } ;; esac

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "Note: uncommitted changes are not deployed." >&2; fi
git archive HEAD | "${SSH[@]}" "rm -rf \"\$HOME/$DIR.stage\" && mkdir -p \"\$HOME/$DIR.stage\" && cd \"\$HOME/$DIR.stage\" && tar -x"
"${SSH[@]}" "set -o pipefail; export PATH=\$HOME/.local/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  live=\"\$HOME/$DIR\" stage=\"\$HOME/$DIR.stage\" prev=\"\$HOME/$DIR.prev\"
  cd \"\$stage\" || exit 1
  # machine state that isn't in git
  for f in .env.local .env.local.bak .pty-hash; do [ -e \"\$live/\$f\" ] && cp -p \"\$live/\$f\" .; done
  pnpm install --frozen-lockfile >/dev/null || { echo 'pnpm install failed; the running app was left as is' >&2; exit 1; }
  pnpm build > .deploy-build.log 2>&1 || { tail -40 .deploy-build.log >&2; echo 'Build failed; the running app was left as is' >&2; exit 1; }
  grep -E 'Compiled' .deploy-build.log
  for u in agent-u agent-u-pty; do
    dst=\$HOME/.config/systemd/user/\$u.service
    if [ -f \"\$dst\" ] && ! cmp -s deploy/\$u.service \"\$dst\"; then cp \"\$dst\" \"\$dst.bak\" && cp deploy/\$u.service \"\$dst\" && echo \"updated \$u.service (old one in \$u.service.bak)\" && systemctl --user daemon-reload; fi
  done
  # the terminal backend holds open shells; restart it only when its own code changed
  units=agent-u
  pty=\$(cat server/* package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [ \"\$pty\" != \"\$(cat .pty-hash 2>/dev/null)\" ] || ! systemctl --user is-active --quiet agent-u-pty; then units=\"agent-u agent-u-pty\"; fi
  # running processes keep their (renamed) folder until they restart
  rm -rf \"\$prev\"
  [ -d \"\$live\" ] && mv \"\$live\" \"\$prev\"
  mv \"\$stage\" \"\$live\"
  cd \"\$live\"
  if systemctl --user restart \$units && sleep 4 && systemctl --user is-active --quiet \$units && curl -fsS -o /dev/null -m 10 http://127.0.0.1:3311/login; then
    echo \"\$pty\" > .pty-hash
    systemctl --user is-active \$units
  else
    echo 'The new release did not come up; rolling back' >&2
    [ -d \"\$prev\" ] || exit 1
    mv \"\$live\" \"\$live.failed\" && mv \"\$prev\" \"\$live\" && rm -rf \"\$live.failed\"
    systemctl --user restart \$units
    exit 1
  fi"
