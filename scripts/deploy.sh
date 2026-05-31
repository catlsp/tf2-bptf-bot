#!/usr/bin/env bash
# Pull + build + restart on VPS #2. Run as the app user from the repo root.
set -euo pipefail

log() { echo -e "\033[1;34m[deploy]\033[0m $*"; }

if [[ ! -f .env ]]; then echo "missing .env — copy .env.example and fill it in"; exit 1; fi

log "git pull"
git pull --ff-only

log "install deps"
pnpm install --frozen-lockfile

log "prisma generate + migrate deploy"
pnpm db:generate
pnpm --filter @bptf/db migrate

log "build"
pnpm build

log "(re)start pm2"
pm2 startOrReload ecosystem.config.js
pm2 save

log "done. tail logs: pm2 logs bptf-bot"
