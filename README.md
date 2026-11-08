# Gutad — restaurant commerce platform (gutad.io)

One restaurant page can **sell a meal, reserve a table, sell an experience ticket, or collect a private-event inquiry**. Merchants publish the same capabilities on a branded site, QR code, or embeddable widget. The platform models **channel** (attribution & fees), **seller** (who earns food revenue) and **fulfillment site** (where the work happens) independently, with a double-entry ledger behind every money movement.

| App | Stack | Path |
|---|---|---|
| API + worker | NestJS 11, Drizzle ORM, PostgreSQL 16 (PostGIS image), Redis 7 | `apps/api` |
| Web (public, merchant portal, admin) | Next.js 15 (App Router), Tailwind | `apps/web` |
| Mobile (consumer, merchant tablet, driver) | React Native / Expo SDK 58, expo-router | `apps/mobile` |
| Shared contracts & API client | TypeScript | `packages/shared` |
| Deployment | Docker Compose, Caddy (auto-TLS), nightly backups | `deploy/`, `docker-compose*.yml` |

All 30 capabilities from the master blueprint are implemented — see [`docs/CAPABILITY-MAP.md`](docs/CAPABILITY-MAP.md) for the capability → module → endpoint map and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the money model, state machines and reliability rules.

## Quick start (local, Docker)

```bash
cp .env.example .env            # defaults work locally
docker compose up --build       # postgres, redis, api :4000, worker, web :3000
```

Then open http://localhost:3000 (web) and http://localhost:4000/docs (Swagger). The seed creates:

| Account | Email | Password |
|---|---|---|
| Platform admin | `admin@gutad.io` (env `ADMIN_EMAIL`) | `admin12345` (env `ADMIN_PASSWORD`) |
| Merchant owner | `owner@demo.gutad.io` | `merchant12345` |
| Host staff | `host@demo.gutad.io` | `merchant12345` |
| Customer | `customer@demo.gutad.io` | `customer12345` |
| Driver | `driver@demo.gutad.io` | `driver12345` |

Demo data: **Demo Bistro** (pickup, delivery, reservations, wine-tasting experience, private events) and **Demo Kitchen Collective** (shared kitchen producing two virtual brands in one bag). Promo code `WELCOME10`. Set `SEED_DEMO=false` to seed only the admin and plans.

## Quick start (no Docker)

```bash
npm install
npm run build:shared
# Postgres + Redis running locally, then:
export DATABASE_URL=postgresql://gutad@localhost:5432/gutad REDIS_URL=redis://localhost:6379 JWT_SECRET=dev-only-secret-change-me-please
(cd apps/api && npm run db:migrate:dev && npm run db:seed:dev && npm run start:dev)   # API :4000
(cd apps/api && npm run build && npm run start:worker)                                # worker
(cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:4000 npm run dev)                # web :3000
(cd apps/mobile && EXPO_PUBLIC_API_URL=http://<your-lan-ip>:4000 npm start)           # Expo
npm run smoke                                                                         # 69 end-to-end checks
```

## Production on a VPS (gutad.io)

See [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md). Short version:

```bash
# DNS: A records for gutad.io, www.gutad.io, api.gutad.io → VPS IP
git clone <repo> /opt/gutad && cd /opt/gutad
./deploy/deploy.sh      # first run generates .env with random secrets — review DOMAIN/API_DOMAIN/ACME_EMAIL
./deploy/deploy.sh      # builds images, runs migrations+seed, starts Caddy with Let's Encrypt
```

Services: `postgres` (PostGIS image, persistent volume), `redis`, `api`, `worker`, `web`, `caddy` (TLS for `gutad.io`, `www`, `api.gutad.io`), `backup` (nightly `pg_dump`, 14-day retention).

## Integrations (switch by env, no code changes)

| Concern | Default | Production option |
|---|---|---|
| Payments | `PAYMENT_PROVIDER=mock` | `stripe` — Stripe Connect destination charges, manual capture, refunds, transfers, webhooks (`/webhooks/payments`) |
| Last-mile delivery | `DELIVERY_PROVIDER=mock` (auto-progresses jobs) | `doordash` (Drive v2, JWT auth) or `uber` (Uber Direct) — quotes, jobs, cancel, webhooks (`/webhooks/delivery`) |
| Own fleet | built in | set a location's `deliveryFleet=PLATFORM`: offers to nearby drivers, driver app, earnings & payouts |
| SMS / email / push | `log` (written to worker logs) | Twilio REST, HTTP email relay, Expo push |
| POS | generic HMAC-signed webhook inbox (`/webhooks/integrations/:id`) | map menu items/tables to POS ids; events `pos.check.closed`, `pos.item.86`, `pos.ticket.ack` |
| Geocoding | `mock` | `GEOCODER_PROVIDER=google` + key (client-side verify step) |

## Repository layout

```
apps/api/src
  db/schema/*        Drizzle schema (≈105 tables), migrate.ts, seed.ts
  core/              ledger (double-entry), outbox, notify, audit, crypto, redis
  common/            JWT guard + roles, idempotency interceptor, zod pipe, utils
  modules/           one module per capability group (auth, merchants, discovery, catalog, contracts,
                     payments, delivery, growth, crm, kitchen, orders, reservations, events, programs,
                     settlement, integrations, support, reporting, admin, notifications)
  jobs/              scheduler run by the worker process (outbox relay, expiries, reminders, settlement…)
apps/web/src/app     /, /search, /r/[slug], /order/[slug], /checkout, /orders/[id], /reservations/[code],
                     /embed/book/[slug], /events/inquiry/[id], /group/[code], /meal-kits, /account,
                     /for-restaurants, /driver, /merchant/*, /admin/*
apps/mobile/app      (tabs) discover/orders/tables/account, r/[slug], reserve/[slug], checkout, order/[id],
                     merchant/{index,host,kitchen}, driver/index, login
```

## Scripts

| Command | What |
|---|---|
| `npm run typecheck` | typecheck shared, api, web, mobile |
| `npm run smoke` | end-to-end smoke test against `API_URL` (default localhost:4000) |
| `npm run db:migrate` / `db:seed` (in `apps/api`) | apply SQL migrations / idempotent seed |
| `npm run db:generate` (in `apps/api`) | generate a new SQL migration after schema changes |
| `npm run build:android` / `build:ios` (in `apps/mobile`) | EAS production builds |

## Status & honesty notes

- Verified here: migrations against PostgreSQL 16, API boot, worker relay, 69/69 smoke checks (ordering, idempotency, intake, kitchen fan-out & packing, delivery dispatch, reservations incl. oversell protection, waitlist, tickets, private events, group orders, meal kits, incidents/refunds, statements/payouts, ledger balance, reporting, admin RBAC), Next.js production build, Expo Metro bundle.
- Not exercised here: real Stripe/DoorDash/Uber/Twilio accounts (adapters follow the public APIs; test with sandbox keys before launch), Docker image builds (Dockerfiles are written against the verified lockfile), device builds (EAS).
- Published fee benchmarks in `PLAN_CATALOG` are pilot defaults, not launch prices — set contracts per merchant from the admin portal.
