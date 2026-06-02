#!/usr/bin/env bash
# Focused redeploy of apps/api to the VPS, driven from your local machine.
#
# Deliberately git-based (not rsync) and source-run via tsx — matching scripts/
# deploy.sh and the PM2 ecosystem. It pulls the latest code on the box, installs,
# regenerates the Prisma client, and restarts ONLY bptf-api, so the bot's live
# Steam session is left untouched. For a full deploy (bot included, migrations,
# build) use scripts/deploy.sh on the box instead.
#
# Usage:
#   export VPS_HOST=bptf@your.vps.host       # required (user@host)
#   export VPS_PATH=/home/bptf/tf2-bptf-bot  # optional, this is the default
#   ./scripts/deploy-api.sh
#
# Prereqs on the VPS: the repo is already cloned, apps/api/.env exists (with the
# Neon pooler DATABASE_URL + PORT/HOST/CORS_ORIGIN), and bptf-api is defined in
# ecosystem.config.js. The local commits you want deployed must already be pushed
# to the remote the VPS tracks.
set -euo pipefail

VPS_HOST="${VPS_HOST:?Set VPS_HOST, e.g. export VPS_HOST=bptf@1.2.3.4}"
VPS_PATH="${VPS_PATH:-/home/bptf/tf2-bptf-bot}"

log() { echo -e "\033[1;34m[deploy-api]\033[0m $*"; }

log "deploying apps/api to ${VPS_HOST}:${VPS_PATH}"

ssh "${VPS_HOST}" bash -se <<REMOTE
set -euo pipefail
cd "${VPS_PATH}"

echo "[remote] git pull"
git pull --ff-only

echo "[remote] install deps (frozen lockfile)"
pnpm install --frozen-lockfile

echo "[remote] prisma generate"
pnpm db:generate

echo "[remote] (re)start bptf-api"
# startOrReload picks up a freshly-added ecosystem entry on first deploy, then
# reloads in place on subsequent ones.
pm2 startOrReload ecosystem.config.js --only bptf-api
pm2 save

echo "[remote] done"
REMOTE

log "done. tail logs:  ssh ${VPS_HOST} 'pm2 logs bptf-api'"
