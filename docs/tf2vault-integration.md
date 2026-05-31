# tf2vault-bot integration (VPS #1)

These are copy-paste snippets for your **existing** `bot.js`. They make the two
bots share one Steam account safely via the local Redis on VPS #2.

> Do not refactor `bot.js`. Paste these in, adjust the import paths, done.
> All snippets are **plain ESM JS** (matching your `import ...` style), not TS.

---

## ⚠️ Read this first — session exclusivity

`steam-user` holds **one** live session per account. If both bots call
`client.logOn()` at the same time, Steam will kick whichever logged in first and
the two will fight over the session indefinitely.

`withSteamLock()` serializes **API actions** (sending/cancelling offers, reading
inventory) but it does **not** make two persistent logins coexist. Pick one of:

- **Recommended for Phase 1:** keep `tf2vault-bot` as the only logged-in session.
  Run `bptf-bot` in paper mode **without** a Steam login (it only reads inventory,
  which it can do over the public `steamcommunity.com/inventory` endpoint like
  your `fetchBackpackItems`). Set `bptf-bot` to skip `startSteam()` if you go this
  route.
- **If both must be logged in:** they still share the lock for every Steam call,
  and you accept occasional re-logins. Lower risk if only one is actively trading
  (which is the case in Phase 1–2, where `bptf-bot` sends nothing).

Either way, the reservation set + lock below prevent double-spending items.

---

## 1. Connect to the same Redis

VPS #1 reaches VPS #2's Redis over Tailscale. Bind Redis on VPS #2 to its
Tailscale IP (or keep it localhost and run a Tailscale-only tunnel). Add to
VPS #1's `.env`:

```
REDIS_URL=redis://100.x.y.z:6379/0      # VPS #2 Tailscale IP
```

Near the top of `bot.js`, after the other imports:

```js
import IORedis from 'ioredis';

const sharedRedis = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});
sharedRedis.on('error', e => console.error('[BOT] shared redis error:', e.message));
sharedRedis.on('connect', () => console.log('[BOT] shared redis connected'));
```

---

## 2. `withSteamLock()` — JS version

Wrap every Steam-touching action (offer send, offer cancel, inventory load).
Same key/TTL/Lua as `bptf-bot` so both bots take the *same* mutex.

```js
import { randomUUID } from 'crypto';

const STEAM_LOCK_KEY = 'shared:steam:lock';
const STEAM_LOCK_TTL_SEC = 30;
const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

async function withSteamLock(op, fn, { retries = 5, retryDelayMs = 2000 } = {}) {
  const value = randomUUID();
  for (let i = 0; i < retries; i++) {
    const ok = await sharedRedis.set(STEAM_LOCK_KEY, value, 'EX', STEAM_LOCK_TTL_SEC, 'NX');
    if (ok) {
      try {
        return await fn();
      } finally {
        await sharedRedis.eval(RELEASE_LUA, 1, STEAM_LOCK_KEY, value);
      }
    }
    console.warn(`[BOT] steam lock busy (${op}), retry ${i}`);
    await new Promise(r => setTimeout(r, retryDelayMs));
  }
  throw new Error(`steam lock unobtainable for ${op}`);
}
```

Then wrap your sends. In `processRequest`, replace the bare `offer.send(...)`
promise with:

```js
await withSteamLock('offer.send', () => new Promise((resolve, reject) => {
  offer.send((err, status) => {
    if (err) return reject(err);
    console.log(`[BOT] Offer отправлен: id=${offer.id}, status=${status}`);
    resolve();
  });
}));
```

And `cancelSteamOffer`:

```js
async function cancelSteamOffer(steamOfferId) {
  return withSteamLock('offer.cancel', () => new Promise((resolve, reject) => {
    manager.getOffer(steamOfferId, (err, offer) => {
      if (err) return reject(new Error(`Не удалось получить оффер: ${err.message}`));
      offer.cancel(err2 => (err2 ? reject(new Error(err2.message)) : resolve()));
    });
  }));
}
```

---

## 3. Reserve assetIds before sending

Before `offer.send`, after you've added items, reserve everything you put in the
offer so `bptf-bot` can't grab the same asset:

```js
const RESERVED_SET = 'shared:steam:reservedItems';

async function reserveItems(assetIds) {
  if (!assetIds.length) return true;
  const added = await sharedRedis.sadd(RESERVED_SET, ...assetIds);
  return added === assetIds.length;
}
async function releaseItems(assetIds) {
  if (assetIds.length) await sharedRedis.srem(RESERVED_SET, ...assetIds);
}
```

Wrap the send. `offer.itemsToGive` holds your side's items after you `addMyItem`:

```js
const myAssetIds = offer.itemsToGive.map(i => i.assetid);
const reserved = await reserveItems(myAssetIds);
if (!reserved) {
  await releaseItems(myAssetIds); // partial cleanup
  throw new Error('Один из предметов уже зарезервирован другим ботом');
}
try {
  await withSteamLock('offer.send', () => /* offer.send promise from §2 */);
} finally {
  // release on send-failure; on success release after the trade settles instead
  // (do it in sentOfferChanged when state becomes Accepted/Declined/Expired)
  if (!offer.id) await releaseItems(myAssetIds);
}
```

In your existing `manager.on('sentOfferChanged', ...)`, release the items once the
offer reaches a terminal state (states 3/5/6/7/10):

```js
if ([3, 5, 6, 7, 10].includes(state)) {
  const ids = (offer.itemsToGive || []).map(i => i.assetid);
  await releaseItems(ids).catch(() => {});
}
```

---

## 4. Only accept inbound trades for your defindexes

`tf2vault-bot` should keep owning inbound offers (your bot already declines
everything not system-initiated). To make that explicit and future-proof against
`bptf-bot`'s items, gate acceptance on the defindexes you own:

```js
// keys + metal that tf2vault-bot manages
const TF2VAULT_OWNED_DEFINDEXES = new Set([5021, 5002, 5001, 5000, 725]);

function offerOnlyTouchesOwnedDefindexes(offer) {
  const all = [...(offer.itemsToGive || []), ...(offer.itemsToReceive || [])];
  return all.every(i => TF2VAULT_OWNED_DEFINDEXES.has(i.defindex));
}
```

Your `newOffer` handler already declines non-system offers, so no behavior change
is required today. When you later add any auto-accept path, guard it with
`offerOnlyTouchesOwnedDefindexes(offer)` so it never touches a `bptf-bot` cosmetic.

---

## Verification

After applying, on VPS #1:

```bash
redis-cli -u "$REDIS_URL" ping            # PONG
redis-cli -u "$REDIS_URL" smembers shared:steam:reservedItems
redis-cli -u "$REDIS_URL" get shared:steam:lock   # nil unless mid-trade
```

Send one test exchange through tf2vault-bot and confirm the asset shows up in
`reservedItems` during the send and is gone after the offer settles.
