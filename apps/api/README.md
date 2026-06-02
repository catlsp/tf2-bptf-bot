# @bptf/api

Fastify REST + WebSocket API that backs the TF2 trading-bot management panel
(`apps/web`). It reads the same Neon Postgres the bot writes to, and exposes a
small set of CRUD/admin operations over `OurListing` and `WatchlistEntry`.

It is **read-mostly**: the only writes are a soft-delete on `OurListing` (the bot
reconciles the bp.tf side) and full CRUD on `WatchlistEntry`. Everything else is
populated by `apps/bot`.

## Stack

- **Fastify 4** with `fastify-type-provider-zod` — every route validates
  `params` / `querystring` / `body` and serializes its `response` through a Zod
  schema, so the wire contract is type-safe end to end.
- **@fastify/cors**, **@fastify/websocket**
- **Prisma** via `@bptf/db` (shared client). A retry extension in
  [`src/lib/db.ts`](src/lib/db.ts) transparently retries transient connection
  errors (see [Neon notes](#neon-connection-notes)).
- Runs on **tsx**, like the bot — no compile step. `build` just typechecks.

## Running locally

```bash
# from repo root
cp apps/api/.env.example apps/api/.env   # then fill DATABASE_URL (same as the bot)
pnpm --filter @bptf/db generate          # generate the Prisma client (once)
pnpm --filter @bptf/api dev              # tsx watch, http://127.0.0.1:3001
```

Both `dev` and `start` load `apps/api/.env` natively via Node's `--env-file`, so
the API is self-contained for env (including pointing at the Neon pooler URL
independently of the bot). The PM2 entry does the same — see [Deploy](#deploy).

### Scripts

| script      | what it does                                  |
| ----------- | --------------------------------------------- |
| `dev`       | `tsx watch --env-file=.env` (reload)          |
| `start`     | `node --import tsx --env-file=.env src/index.ts` |
| `build`     | `tsc --noEmit` (typecheck only)               |
| `typecheck` | `tsc --noEmit`                                |
| `lint`      | `eslint src`                                  |

## Environment

| var           | default                 | notes                                          |
| ------------- | ----------------------- | ---------------------------------------------- |
| `PORT`        | `3001`                  |                                                |
| `HOST`        | `127.0.0.1`             | bind only to loopback; reach it over SSH tunnel |
| `DATABASE_URL`| —                       | required; same Neon URL the bot uses           |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated list of allowed browser origins |
| `LOG_LEVEL`   | `info`                  | `trace`…`fatal`                                |

Missing/invalid env fails fast at boot (see [`src/lib/env.ts`](src/lib/env.ts)).

## REST endpoints

All under the `/api` prefix. There is also an unprefixed `GET /health` →
`{ "status": "ok" }`.

| method   | path                       | query / body                                                | returns                              |
| -------- | -------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| `GET`    | `/api/dashboard`           | —                                                           | aggregate stats (below)              |
| `GET`    | `/api/orders`              | `status?`, `skuKey?`, `limit=50`, `offset=0`                | `{ data: OurListing[], total }`      |
| `DELETE` | `/api/orders/:id`          | —                                                           | soft-deleted `OurListing` (or 404)   |
| `GET`    | `/api/watchlist`           | —                                                           | `WatchlistEntry[]`                   |
| `POST`   | `/api/watchlist`           | `{ skuKey, maxBuyRef, minSellRef?, priority?, notes? }`     | created entry (201) or 409 on dup    |
| `PATCH`  | `/api/watchlist/:id`       | partial `{ maxBuyRef?, minSellRef?, active?, priority?, notes? }` | updated entry (or 404)         |
| `DELETE` | `/api/watchlist/:id`       | —                                                           | `204` (or 404)                       |
| `GET`    | `/api/logs`                | `type?`, `level?`, `from?`, `to?`, `limit=100`, `offset=0`  | `{ data: EventLog[], total }`        |
| `GET`    | `/api/logs/types`          | —                                                           | `string[]` (distinct types, for UI)  |
| `GET`    | `/api/inventory`           | `status?` (`HELD\|LISTED\|RESERVED\|SOLD`)                  | `InventoryItem[]` (with `item`)      |
| `GET`    | `/api/trades`              | `status?`, `intent?`, `limit=50`, `offset=0`                | `Trade[]` (with `item`)              |
| `GET`    | `/api/prices/:skuKey`      | `days=7`                                                     | `PriceSnapshot[]` (asc by time)      |

`DELETE /api/orders/:id` is a **soft delete**: it sets `status='deleting'`,
`deletedAt=now()`. The row is never physically removed here — the bot's reconcile
loop owns the bp.tf side and clears it once the remote listing is gone.

`/api/dashboard` shape:

```json
{
  "activeOurListings": 0,
  "watchlistSize": 20,
  "recentErrors": 0,
  "recentScanCompleted": { "capturedAt": "2026-05-31T23:28:23.542Z", "durationMs": 841, "skuCount": 24 },
  "totalEventLogToday": 0
}
```

### curl examples

```bash
curl -s http://127.0.0.1:3001/health
curl -s http://127.0.0.1:3001/api/dashboard

# orders
curl -s "http://127.0.0.1:3001/api/orders?status=active&limit=20"
curl -s -X DELETE http://127.0.0.1:3001/api/orders/<id>

# watchlist CRUD
curl -s http://127.0.0.1:3001/api/watchlist
curl -s -X POST http://127.0.0.1:3001/api/watchlist \
  -H 'content-type: application/json' \
  -d '{"skuKey":"5021;6","maxBuyRef":62.5,"priority":1,"notes":"keys"}'
curl -s -X PATCH http://127.0.0.1:3001/api/watchlist/<id> \
  -H 'content-type: application/json' -d '{"active":false}'
curl -s -X DELETE http://127.0.0.1:3001/api/watchlist/<id> -i

# logs
curl -s "http://127.0.0.1:3001/api/logs?level=warn&limit=50"
curl -s http://127.0.0.1:3001/api/logs/types

# prices (skuKey contains ';', so quote the URL)
curl -s "http://127.0.0.1:3001/api/prices/5021;6?days=30"
```

## WebSocket `/ws`

Connect to `ws://<host>:<port>/ws`, then subscribe to topics:

```jsonc
// client → server
{ "action": "subscribe",   "topic": "logs" }   // action defaults to "subscribe"
{ "action": "unsubscribe", "topic": "orders" }
// topic ∈ "logs" | "orders" | "trades"
```

```jsonc
// server → client
{ "topic": "logs",   "event": "subscribed",  "data": null }
{ "topic": "logs",   "event": "created",     "data": { /* EventLog */ } }
{ "topic": "orders", "event": "updated",     "data": { /* OurListing */ } }
{ "topic": "trades", "event": "created",     "data": { /* Trade incl. item */ } }
```

v1 implementation polls the DB every 2s for rows newer than the last high-water
mark and broadcasts the diff only to topics that currently have subscribers. A
fresh connection only sees activity from after it subscribed (no backlog). v2
will swap polling for Postgres `LISTEN/NOTIFY` without changing this protocol.

## Neon connection notes

This API is request-driven and goes idle between clicks, so Neon's serverless
free tier reaps the pooled TCP connections. The next query then hits a dead
connection (`P1017 "Server has closed the connection"`). The bot never sees this
because its scanner keeps the pool warm. [`src/lib/db.ts`](src/lib/db.ts) wraps
every Prisma operation in a bounded retry that lets the pool evict the dead
connection and reconnect — all API operations are reads or single-row idempotent
writes, so retrying a never-committed query is safe.

For lowest latency under bursty load, point `DATABASE_URL` at Neon's **pooled**
(PgBouncer) endpoint — the `-pooler` host — with `?pgbouncer=true`. The current
URL also carries `connection_limit`/`pool_timeout` tuning to stay a good neighbor
to the bot on the shared instance.

## Deploy

The API runs on the VPS under PM2 via tsx from source (no build artifacts), same
as the bot — see the `bptf-api` entry in [`ecosystem.config.js`](../../ecosystem.config.js).
It binds to `127.0.0.1:3001` only; you reach it from your laptop over an SSH
tunnel.

One-time on the VPS: create `apps/api/.env` (it's gitignored) with the pooler
`DATABASE_URL`, `PORT`, `HOST`, `CORS_ORIGIN`, `LOG_LEVEL`. PM2 loads it via
`--env-file=.env`.

```bash
# Full deploy (bot + api, migrations, build) — run on the VPS, from the repo root:
./scripts/deploy.sh            # pm2 startOrReload ecosystem.config.js picks up bptf-api

# API-only redeploy — run from your laptop (doesn't restart the bot):
export VPS_HOST=bptf@your.vps.host
./scripts/deploy-api.sh
```

### Local front-end against the deployed API

```bash
# terminal 1 — tunnel the VPS API to localhost:3001
ssh -L 3001:127.0.0.1:3001 bptf@your.vps.host

# terminal 2 — run the web dev server (its default VITE_API_URL already targets :3001)
pnpm web
```
