# Blueprint → implementation map

Each row of the master blueprint's capability list, where it lives, and the main endpoints. Web pages are under `apps/web/src/app`, mobile screens under `apps/mobile/app`. Swagger groups endpoints with the same numbering at `/docs`.

| # | Capability | Module | Key endpoints | Web | Mobile |
|---|---|---|---|---|---|
| 01 | Accounts & access | `auth` | `/auth/register,login,guest,refresh,recover*`, `/auth/me`, addresses, push tokens, consents; org memberships & location-scoped roles in `merchants` | `/account`, `/for-restaurants` | `login`, `(tabs)/account` |
| 02 | Merchant & location registry | `merchants` | `/organizations*`, `/locations/:id` (claim, verify, status, pause/resume, hours), legal sellers, brands | `/merchant/settings` | — |
| 03 | Publishing & distribution | `merchants` | `/locations/:id/publications` (listing, branded site, order link, QR, booking widget, partner link), `/public/source`, referral click/conversion | `/order/[slug]`, `/embed/book/[slug]`, settings → QR | — |
| 04 | Local discovery | `discovery` | `/public/search` (text, city, cuisine, geo radius, service, open-now, sponsored ranking), `/public/locations/:slug` (hours, eligible pickup/delivery times, shifts), serviceability | `/`, `/search`, `/r/[slug]` | `(tabs)/index`, `r/[slug]` |
| 05 | Menu & offer catalog | `catalog` | menus/categories/items/modifiers CRUD, channel price overrides, scheduled menus, sold-out (item & option, timed), import, brand content-rights check | `/merchant/menu` | — |
| 06 | Cart & quote | `orders/quote.service` | `POST /quotes`, `/quotes/:id/revalidate` — modifiers rules, minimums, schedule within hours, tax, fees, tips, promos (funder), credits, loyalty, delivery quote, expiry, immutable snapshot | `/checkout` | `checkout` |
| 07 | Order checkout & history | `orders` | `POST /orders` (guest or account, idempotent), `/orders/:id`, `/me/orders`, cancel eligibility, reorder vs current menu, timeline | `/orders/[id]`, `/account` | `order/[id]`, `(tabs)/orders` |
| 08 | Merchant order intake | `orders` | `/locations/:id/orders` inbox, accept (capture + fan-out + dispatch), reject (void), prep-time, ready, throttle & pause, counter/phone orders, unacknowledged escalation + auto-reject (worker) | `/merchant/orders` | `merchant/index` (tablet, heartbeat) |
| 09 | Shared-kitchen production | `kitchen` | eligible brands per kitchen, station tickets fan-out, station queue, ticket transitions, line 86 → replacement/credit, packing verify/release (missing item blocks bag) | `/merchant/kitchen` | `merchant/kitchen` |
| 10 | Kitchen supply & costing | `kitchen` | ingredients, stock & par, recipes (versions, plate cost), purchase orders & receiving, waste, labor, site contribution by brand (royalties) | `/merchant/kitchen` → Supply | — |
| 11 | Pickup & on-site handoff | `orders` | pickup code on READY, `/orders/:id/handoff` (code check), collection timestamp, walk-in/counter intake | `/merchant/orders` | `merchant/index` |
| 12 | Delivery orchestration | `delivery` | zones (polygon/radius), quotes (retail vs provider cost vs subsidy), job created at checkout → dispatched on accept, provider adapters (mock/DoorDash Drive/Uber Direct), webhooks w/ out-of-order guard, tracking, cancel with cost owner, late flags, delivery-only jobs for outside orders, provider invoices | `/merchant/dispatch`, `/orders/[id]` | `order/[id]` |
| 13 | Driver operations | `delivery` | apply/approve, availability & location, offers (first-accept wins), accept/decline, pickup/handoff with proof, earnings, weekly driver payouts | `/driver` | `driver/index` |
| 14 | Reservation inventory | `reservations` | rooms, tables, combinations, shifts (slot/turn/pacing/party limits), blackouts, policy, holds, overlap conflicts with advisory lock | settings → Floor & shifts | — |
| 15 | Booking & policy | `reservations` | availability, book (hold → confirm), guarantee card / deposit, modify, cancel (late policy), reminders, no-show charge, actual headcount, history | `/r/[slug]` Reserve, `/reservations/[code]`, embed widget | `reserve/[slug]`, `(tabs)/reservations` |
| 16 | Host stand & waitlist | `reservations` | host board, phone/walk-in bookings, arrive/seat/move/complete/no-show, waitlist join/notify/seat/leave/expire, floor occupancy | `/merchant/host` | `merchant/host` |
| 17 | Experiences & private events | `events` | experiences & sessions (free / prepaid per person or party / pay at venue, add-ons), ticket hold → pay → confirm, attendance, refund/transfer policy, session close; inquiries → proposal (room hold) → accept + deposit → headcount → settle balance + invoice | `/r/[slug]` Experiences/Events, `/events/inquiry/[id]`, `/merchant/events` | `r/[slug]` |
| 18 | Group, corporate & catering | `programs/group-orders` | budgets, shared/individual/tray modes, join code, cutoff & late joins, allowance overage, consolidated labeled order, employer invoice or individual receipts | `/group/[code]` | — |
| 19 | Meal kits & scheduled distribution | `programs/meal-kits` | products (regions, lead days, stock), order & reserve stock, packing batches, ship/track/deliver, line-level cases → replacement/credit/refund | `/meal-kits`, `/account` → Meal kits | — |
| 20 | Institutional & brand programs | `programs` | program lifecycle (apply→qualify→contract→test→activate→offboard), campus accounts/balances/orders/reversal/statement, B2B operator orders & invoices, creator royalties accrual | admin (tenants) | — |
| 21 | CRM | `crm` | guest profiles (visits, spend, favorites, protected notes, tags, contact prefs), segments, verified reviews & moderation/replies | `/merchant/guests` | — |
| 22 | Growth & loyalty | `growth` | coupons (percent/fixed/free delivery, funder, limits), campaigns (email/SMS consented, sponsored placements, budget stop), loyalty earn/redeem/expire/reverse, referrals, membership plans & renewals | `/merchant/growth`, `/account` → Rewards | `(tabs)/account` |
| 23 | Notifications | `notifications` + `core/notify` | outbox → templates → email/SMS/push/in-app with dedupe keys; transactional vs marketing consent; merchant alerts incl. fallback phone | `/me/notifications` | push registration |
| 24 | Payments & adjustments | `payments` | tokenized intents (manual/auto capture), guarantees, deposits, partial capture, refunds with funder, disputes, credits ledger, Connect onboarding, transfers, webhook inbox & replay | `/merchant/finance` | — |
| 25 | Contracts & monetization | `contracts` | plan catalog, versioned contracts per org/location (commission by channel, cover fees by origin, prepaid fee, subsidies, logistics, rules, effective dates), subscription billing | admin → assign contract, merchant finance | — |
| 26 | Settlement & reconciliation | `settlement` | balances, weekly statements from ledger, payouts (retry/backoff/hold), driver payouts, bank & processor reconciliation, provider invoices, unmatched queue, integrity checks, invoices | `/merchant/finance`, `/admin/finance` | — |
| 27 | Integrations & devices | `integrations` | integration accounts (encrypted creds), id mappings with orphan check, HMAC webhook inbox (POS check/86/ack), devices & heartbeat/offline sweep, health & replay | settings → Devices & POS, `/admin/integrations` | tablet heartbeat |
| 28 | Support & trust | `support` | incidents w/ default owner, timeline, role-based remedies (refund/credit/remake/redelivery/reassign), evidence, appeals, chargeback evidence packet, policy strikes → auto-suspend, data access/erasure | `/admin/support` | report a problem |
| 29 | Reporting & control | `reporting` | location dashboard (sales/conversion by channel, acceptance, prep, delivery reliability & subsidy, covers, waitlist, refunds, incidents, top items), platform dashboard, retention, CSV export, open/close shift with carry-forward | `/merchant`, `/merchant/shift`, `/admin` | — |
| 30 | Platform administration | `admin` | tenant provisioning, entitlements, platform roles, approval limits, settings with second approver, config history, audit trail, secret rotation, `/health`, offboarding with commitment checks | `/admin/*` | — |

## Journeys (blueprint §2) covered by `npm run smoke`

Direct/marketplace pickup · food delivery · shared-kitchen multi-brand meal · delivery-only dispatch · normal reservation · guaranteed reservation (no-show charge) · waitlist/walk-in · ticketed experience · private event · corporate group order · meal kit · membership/credits (loyalty earn) · incident → refund · settlement close → payout → ledger integrity. Campus meals, B2B and creator programs have endpoints under `/programs/*` and `/campus/*` (not in the smoke run because they need a provisioned institution).

## Release gates (blueprint §6)

| Release | Gate | Where enforced / tested |
|---|---|---|
| 1 Direct ordering | duplicate payment callback → one order & receipt; offline merchant escalates; deposit matches statement | `idempotency` on checkout/payment (smoke "duplicate submit"), `escalateUnacknowledged` job, statements built from ledger |
| 2 Reservations | simultaneous bookings + walk-in cannot oversell; deposit applied once; actual covers drive invoice | advisory lock + overlap query (smoke "never oversold"), `depositAppliedCents`, `closeVisit` |
| 3 Delivery | lost API response never dispatches two couriers; late cancel & failed delivery have cost owners | `findByExternalId` before create, `costOwner` on every terminal transition |
| 4 Marketplace | direct vs marketplace fees distinct; campaigns stop at budget; refunds traceable after payout | contract terms by channel (smoke "direct has no commission"), `consumeCoupon` budget stop, refund journal with funder |
| 5 Shared kitchens | missing item stops bag release; sold-out ingredient affects all brands; contribution by site | `releaseBag` 409 (smoke), `consumeIngredients` marks all recipes, `/kitchens/:id/contribution` |
| 6 Programs | each has owner, inventory rules, payer, fulfillment path, failure policy, statement | `programs` module + group orders + meal kit cases |
