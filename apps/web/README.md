# @bptf/web

React + Vite management panel for the TF2 trading bot. Dark-only, TF2-orange
accented UI over [`@bptf/api`](../api/README.md). Personal tool — no auth; reach
it over an SSH tunnel to the API.

## Stack

- **Vite 5 + React 18 + TypeScript** (strict, `noUncheckedIndexedAccess`)
- **TailwindCSS 3** with shadcn/ui-style primitives (`src/components/ui`) built on
  Radix + `class-variance-authority`. Dark theme via CSS variables in `index.css`.
- **TanStack Query 5** — all server state (`src/lib/queries.ts`)
- **React Router 6** — `src/App.tsx`
- **Zustand** — small UI store (live-connection status) in `src/lib/store.ts`
- **recharts** — dashboard histogram + price line chart
- **sonner** — toasts

## Running locally

```bash
cp apps/web/.env.example apps/web/.env   # defaults point at http://localhost:3001
pnpm --filter @bptf/api dev              # start the API first (port 3001)
pnpm --filter @bptf/web dev              # http://localhost:5173
```

Front-end dev against the API on the VPS: open a tunnel, then run the web dev
server — the default `VITE_API_URL`/`VITE_WS_URL` reach the tunnel:

```bash
ssh -L 3001:127.0.0.1:3001 root@VPS_HOST
pnpm --filter @bptf/web dev
```

### Scripts

| script      | what it does                          |
| ----------- | ------------------------------------- |
| `dev`       | Vite dev server (HMR)                 |
| `build`     | `tsc --noEmit && vite build` → `dist` |
| `preview`   | serve the production build            |
| `typecheck` | `tsc --noEmit`                        |
| `lint`      | `eslint src`                          |

## Environment

| var            | default                  | notes                       |
| -------------- | ------------------------ | --------------------------- |
| `VITE_API_URL` | `http://localhost:3001`  | REST base URL               |
| `VITE_WS_URL`  | `ws://localhost:3001/ws` | live WebSocket endpoint      |

## Pages

| route         | what it shows                                                                 |
| ------------- | ----------------------------------------------------------------------------- |
| `/`           | Dashboard: 4 stat cards, 24h events-per-hour bar chart, live activity feed    |
| `/orders`     | OurListing table — status/SKU filters, pagination, soft-delete w/ confirm     |
| `/watchlist`  | WatchlistEntry CRUD — add dialog, inline active toggle, edit/delete           |
| `/logs`       | EventLog feed — type/level/date filters, expandable payload, live pause/resume |
| `/inventory`  | InventoryItem grouped by status tabs (empty until the bot buys)               |
| `/trades`     | Trade table — status/intent filters, row → detail dialog (empty until trading) |
| `/prices/:sku?` | PriceSnapshot line chart — SKU picker, 24h/7d/30d range (empty until snapshots) |

## Live updates

`src/lib/ws.ts` holds a single reconnecting WebSocket. Components call
`useLiveTopic(topic, handler)` to subscribe to `logs` / `orders` / `trades`; the
client ref-counts subscriptions, re-subscribes on reconnect, and backs off
exponentially when the API/tunnel is down. The Dashboard prepends new log events
into its feed; Orders/Trades/Logs invalidate their queries on live events.

> Side effect: while the dashboard (or logs page) is open, the live `logs`
> subscription makes the API poll the DB every ~2s, which keeps Neon's connection
> warm — the panel is fastest when a page is open or the bot is running.

## Notes

- Data shapes mirror the API contract in [`src/lib/types.ts`](src/lib/types.ts);
  dates are ISO strings, Decimals are numbers (the API serializes them).
- Inventory/Trades/Prices intentionally render empty states until Task 3 has the
  bot writing those tables.
- `recharts` makes the JS bundle ~790 kB (234 kB gzip) — fine for an internal,
  tunnel-only tool; revisit with code-splitting if it ever ships wider.
