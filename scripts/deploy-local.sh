#!/bin/zsh
# Production deploy on this machine: builds the web app from a clean checkout of a commit (HEAD by
# default, so uncommitted work never ships), installs it with the server into $NOVA_APP_DIR and
# restarts the LaunchAgent that runs it.
#
#   scripts/deploy-local.sh [git-ref]
#
#   NOVA_APP_DIR  install directory (default ~/.nova-iptv/app, next to the database)
#   NOVA_AGENT    LaunchAgent label to restart (default com.theloop705.nova; skipped if not loaded)
set -euo pipefail

ref=${1:-HEAD}
repo=$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)
app=${NOVA_APP_DIR:-$HOME/.nova-iptv/app}
agent=${NOVA_AGENT:-com.theloop705.nova}
tmp=$(mktemp -d)
trap 'git -C "$repo" worktree remove --force "$tmp/src" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

git -C "$repo" worktree add --detach "$tmp/src" "$ref" >/dev/null
cd "$tmp/src"
# APFS clone of the installed dependencies (instant, no extra disk); falls back to a clean install
cp -Rc "$repo/node_modules" node_modules 2>/dev/null || { rm -rf node_modules; npm ci --silent; }
npm run build:web --silent

mkdir -p "$app"
rsync -a --delete server/ "$app/server/"
rsync -a --delete dist/ "$app/dist/"
git rev-parse --short HEAD > "$app/REVISION"
echo "Installed $(cat "$app/REVISION") in $app"

if launchctl print "gui/$(id -u)/$agent" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$agent"
  echo "Restarted $agent"
fi
