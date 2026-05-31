# tf2-bptf-bot

Private TF2 backpack.tf trading bot. Personal use only. Not for distribution.

Micro-capital junk flipper: scans bp.tf for cheap, liquid items (hats 0.05–2 ref,
strange weapons 0.5–5 ref, killstreak kits, crates), buys 15–25% under fair value,
sells ~12% above cost. Runs alongside an existing `tf2vault-bot` on a **shared
Steam account**, coordinated through a shared Redis.

**Phase 1 = paper trading only. No real Steam offers are sent while
`PAPER_TRADING=true`.**

---

## Layout

```
apps/bot        core trading engine (Node 20 + TS)
apps/telegram   grammY notifications + /commands
packages/db     Prisma schema + client (Neon Postgres)
packages/types  shared TS types (events, trading)
packages/config tsconfig + eslint base
scripts/        VPS provisioning, deploy, paper replay
docs/           tf2vault integration, ops, recovery
```

Stack: pnpm + turborepo, TypeScript strict, `steam-user`/`steam-tradeoffer-manager`/
`steamcommunity`, axios (rate-limited bp.tf client), Prisma + Neon, ioredis,
BullMQ, pino, zod, grammY.

---

## Local setup

Requires Node 20 and pnpm 9, plus a local Redis (or point at the VPS Redis over
Tailscale).

```bash
pnpm install
cp .env.example .env          # fill in every value (see comments in the file)

# database (Neon)
pnpm db:generate
pnpm --filter @bptf/db migrate:dev   # creates the initial migration + applies it

# run both processes (two terminals, or use pm2)
pnpm bot         # apps/bot
pnpm telegram    # apps/telegram
```

`pnpm dev` runs everything through turbo if you prefer a single command.

### Env vars

Every variable is documented inline in [.env.example](.env.example) and validated
at boot by `apps/bot/src/config/index.ts` (zod). Highlights:

| Var | Meaning |
|---|---|
| `PAPER_TRADING` | **Must stay `true`** until you explicitly flip it. No Steam offers while true. |
| `EMERGENCY_STOP` | Seed value for the circuit breaker (also toggled via Telegram `/stop`). |
| `STEAM_*` | Same account as tf2vault-bot. `SHARED_SECRET` = login TOTP, `IDENTITY_SECRET` = mobile confirms (Phase 3+). |
| `BPTF_*` | backpack.tf API key + user token. |
| `TF2VAULT_RESERVE_KEYS` / `_REFINED` | Currency held back for tf2vault-bot. Default 0 in dev; raise before thesis defense. |
| `BUY_DISCOUNT_PCT` / `SELL_MARKUP_PCT` | Strategy knobs (20 / 12 by default). |
| `MAX_POSITION_PER_SKU` / `MAX_DAILY_TRADES` / `DAILY_LOSS_CUTOFF_PCT` | Risk caps. |
| `BPTF_MAX_REQ_PER_MIN` | Hard ceiling, **never above 60**. |

---

## Verifying paper mode (Phase 1 acceptance)

1. `PAPER_TRADING=true` in `.env`.
2. `pnpm bot` → logs show `bptf-bot starting … paper:true`, Steam login, then
   `scanner scheduled` and `scan complete`.
3. `pnpm telegram` → send `/start`; you get a status reply. `/stats` shows scans.
4. Within a couple of minutes you should see `paper trade recorded` log lines and
   Telegram `PAPER BUY/SELL` notifications when opportunities appear.
5. Confirm **zero** Steam offers: your Steam client shows no outgoing trades, and
   no `Offer sent` logs appear (only `paper:` trade ids in the DB `Trade` table).

The hard guard: `trading/tradeExecutor.ts` → `sendRealOffer()` throws
`PaperGuardError` while `PAPER_TRADING=true`, so no code path can send an offer.

---

## Deploy to VPS #2

```bash
# on the VPS, as root
sudo bash scripts/setup-vps.sh      # Node 20, pnpm, pm2, Redis (60mb/LRU/no-persist), swap, ufw, tailscale
tailscale up

# as the bptf user
git clone <your private remote> ~/tf2-bptf-bot && cd ~/tf2-bptf-bot
cp .env.example .env && $EDITOR .env
bash scripts/deploy.sh              # install, prisma migrate deploy, build, pm2 start
pm2 logs bptf-bot
```

The dashboard (Phase 9) runs on your laptop and reaches the VPS over Tailscale —
nothing is exposed publicly (ufw denies all inbound except SSH + `tailscale0`).

Integrating with the existing bot on VPS #1: follow
[docs/tf2vault-integration.md](docs/tf2vault-integration.md) — copy-paste JS
snippets, no refactor of `bot.js`.

---

## Kill switches

| Action | How |
|---|---|
| Pause trading (keep scanning) | Telegram `/stop` → `/resume` |
| Stop the engine | `pm2 stop bptf-bot` |
| Guarantee no offers | `PAPER_TRADING=true` + `pm2 restart bptf-bot` |
| Full halt | `pm2 stop all` |

See [docs/operations.md](docs/operations.md) and
[docs/recovery.md](docs/recovery.md) for daily checks and recovery.

---

## Phase roadmap

Phase 1 (this build): scan + paper trade + Telegram, zero offers. Phases 2–10:
real listings, real offers, inbound handler, risk engine, smarter pricing,
watchlist auto-expansion, backtesting, dashboard, backups. Each phase is gated in
code and by env so promotion is deliberate.
