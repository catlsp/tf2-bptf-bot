# Disaster recovery

## Bot crashed / restart loop

pm2 auto-restarts with backoff. If it's looping:

```bash
pm2 logs bptf-bot --err --lines 100
```

Common causes:
- **Invalid env** → `ConfigError` lists the offending vars. Fix `.env`, `pm2 restart bptf-bot`.
- **Neon unreachable** → check `DATABASE_URL`; Neon free tier sleeps idle DBs (first query wakes it, ~1s).
- **Redis down** → `systemctl status redis-server`; `systemctl restart redis-server`.
- **Steam re-login loop (eresult 84 = RateLimitExceeded)** → the wrapper already backs off 5 min. Stop the process, wait, restart.

## Steam session lost

The client re-logs in automatically on `error` with TOTP. If it can't:
- Verify `STEAM_SHARED_SECRET` is correct and the VPS clock is synced (`timedatectl` → NTP active). TOTP fails on clock drift.
- Confirm tf2vault-bot isn't holding the only allowed session (see `tf2vault-integration.md` → session exclusivity).

## Stale reservations (items stuck "reserved")

If a process died mid-trade, assetIds can linger in `shared:steam:reservedItems`:

```bash
redis-cli smembers shared:steam:reservedItems
redis-cli srem shared:steam:reservedItems <assetid>   # only if you've confirmed it's stale
```

The Steam lock self-heals via its 30s TTL; the reservation set does not, so clear
it manually only after confirming no offer is in flight.

## Neon backup / restore

```bash
# export (run from laptop or any machine with psql)
pg_dump "$DATABASE_URL" -Fc -f bptf-$(date +%F).dump
# restore into a fresh Neon branch
pg_restore --no-owner -d "$NEW_DATABASE_URL" bptf-2026-01-01.dump
```

## Full rebuild on a new VPS

1. `scripts/setup-vps.sh`
2. clone repo as the `bptf` user, create `.env`
3. `scripts/deploy.sh`
4. `tailscale up`
5. confirm `/start` in Telegram responds and `/balance` populates within 5 min.
