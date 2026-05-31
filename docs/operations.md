# Operations checklist

## Daily

- [ ] `pm2 status` — both `bptf-bot` and `bptf-telegram` online, restarts not climbing.
- [ ] Telegram `/stats` — scans running (~1440/day at 60s), errors near zero.
- [ ] Telegram `/balance` — available keys/ref look right; reserves match `.env`.
- [ ] `pm2 logs bptf-bot --lines 50` — no repeating Steam re-login or bp.tf 429s.
- [ ] Confirm `PAPER_TRADING=true` is still set (`grep PAPER .env`) until you intend to flip it.

## Weekly

- [ ] Review paper trades: `EventLog` rows of type `paper.buy` / `paper.sell`.
- [ ] Spot-check a few decisions against bp.tf manually — is fair value sane?
- [ ] Tune `BUY_DISCOUNT_PCT` / `SELL_MARKUP_PCT` if the bot finds too few/many opportunities.
- [ ] Check Redis memory: `redis-cli info memory | grep used_memory_human` (cap is 60 MB).
- [ ] Check swap: `free -h` — if swap is heavily used, something is leaking.

## Kill switches (in order of bluntness)

1. **Pause trading, keep scanning data:** Telegram `/stop` (sets `bptf:emergencyStop`). `/resume` to undo.
2. **Stop the bot process:** `pm2 stop bptf-bot`.
3. **Hard guarantee no offers:** ensure `PAPER_TRADING=true` in `.env` and `pm2 restart bptf-bot`.
4. **Full halt:** `pm2 stop all`.

## bp.tf rate limit

The client enforces ≤60 req/min internally (`BPTF_MAX_REQ_PER_MIN`). If you see
HTTP 429 in logs, you've either raised the cap (don't) or another process shares
the key. With a 20-SKU watchlist at 2 calls/SKU + 1 key-price call, a scan is ~41
requests — comfortably under the ceiling for a 60s interval.

## Promoting through phases

Phase gates are env-driven and code-guarded:

- Phase 1 → 2: implement listing creation (`trading/seller.ts`, `jobs/listingRefresh.ts`). Still `PAPER_TRADING=true`.
- Phase 2 → 3: set `PAPER_TRADING=false`. `tradeExecutor.sendRealOffer` stops throwing once implemented. Do this only after a full paper-trading review.
- Before thesis defense: raise `TF2VAULT_RESERVE_KEYS=5`, `TF2VAULT_RESERVE_REFINED=50`.
