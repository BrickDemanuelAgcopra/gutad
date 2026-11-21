# Courier Release 2 — kitchen-ready sync, multi-brand manifests, batching policy, market pay, DoorDash Drive

Started 2026-11-21. Builds on Courier R1 (4b6838c, 8eb50de). Release 2 of the driver spec.

## Gaps found in the current code
- Delivery is dispatched when the merchant accepts the order (`OrdersService.accept` → `DeliveryService.dispatch`).
  The kitchen marking the order READY (`KitchenService.markOrderReady`) never reaches delivery. Couriers get offers
  at accept time, so they arrive early and wait. Partners only get `pickupReadyAt = promiseAt` once.
- Waiting pay counts from the courier's pickup arrival. A courier who arrives before the promised ready time is paid
  to wait for food that was never due yet.
- One job per order. A shared-kitchen order with several brands (the demo food hall) has no per-brand breakdown,
  so the courier checks one bag count for the whole order.
- Batching settings (`delivery.batching`) are global JSON. `maxOrders` is not enforced at accept, and there is no UI.
- Pay and waiting policy (`delivery.pay`) is global. There is nothing per market.
- DoorDash Drive adapter bugs:
  - `createJob` accepts `/quotes/{job.id}`, but the quote was created at checkout under a different external id, and
    DoorDash quotes last only 5 minutes. The call would fail.
  - Webhooks are not authenticated.
  - Returns map to FAILED.
  - It sends no items or alcohol flag.
  - There is no ready-time update.
  - Cancellation fees and actual fees are never read back.

## Markets
A market is an operating region (`regions`, nestable). A job's market is the region of its location, walking up
`parent_id` to the first region that has a policy row. With no row, the global settings apply.

## What Release 2 adds

| Area | Addition |
|---|---|
| Kitchen-ready sync | Each job carries `estReadyAt` (from the promise or accept prep time, updated by the kitchen) and `readyAt` (actual). Own-fleet offers are held until `estReadyAt − (expected travel to pickup + lead minutes)`. READY releases a held job at once and tells the assigned courier. A refire moves the job back to PREPARING with a new estimate. Partners get pickup-time updates when the estimate moves ≥ `resyncMinutes`. The kitchen sees incoming couriers with an ETA. |
| Fair waiting | Pickup waiting counts from `max(arrivedPickupAt, estReadyAt as shown at accept)`. Grace, rate and a cap come from the market policy. Dropoff waiting is paid after its own grace. Kitchen delay minutes are stored on the job and feed the R1 review exclusion. |
| Multi-brand manifests | `delivery_jobs.manifest`: brands → order, items, bag count, handling. It is built at dispatch and refreshed at READY from packing (bags). Multi-brand jobs require a per-brand pickup check (`MANIFEST_INCOMPLETE` otherwise). Partners receive the item list (brand-prefixed) and the alcohol flag. |
| Batching policy | `delivery.batching` gains the fields below, all overridable per market. `maxOrders` is enforced at offer and accept. Admin UI with a "why not batched" preview. |
| Market pay | `courier_market_policies` (region → pay overrides + batching overrides, versioned). The offer and earnings snapshot record `{ marketId, marketVersion }`. Admin UI per market. |
| DoorDash Drive | Create the delivery directly (`POST /drive/v2/deliveries`, idempotent on our job id). Send items, alcohol flag, pickup/dropoff instructions and pickup time. Update the pickup time on kitchen changes. Authenticate webhooks with a shared secret. Map returns and pick up proof images. Read actual and cancellation fees into reconciliation. Admin connectivity test. |

## Settings and policy shapes (`@gutad/shared`)
```ts
interface BatchingConfig {          // existing fields kept
  enabled, maxOrders, readyWindowMinutes, maxBearingDiff, maxExtraMinutes,
  allowMixedTemperature: boolean,   // default true; false → HOT and COLD jobs are not batched
  excludeRequirements: string[],    // default ['ALCOHOL']: such jobs are never batched
  maxDropoffSpreadKm: number,       // default 3: max distance between batched dropoffs
}
interface CourierPayPolicy {        // existing fields kept
  ..., waitingCapMinutes: number,   // default 30 (pickup + dropoff waiting paid at most this many minutes)
  dropoffGraceMinutes: number,      // default 5
}
interface ReadySyncConfig {         // setting `delivery.readySync`
  enabled: boolean,                 // default true
  offerLeadMinutes: number,         // default 5 — offers go out this long before the courier must leave
  pickupTravelMinutes: number,      // default 8 — typical travel to the pickup used to time the offer
  resyncMinutes: number,            // default 3 — partner pickup time updated when the estimate moves this much
  defaultPrepMinutes: number,       // default 15 — when there is no promise
}
```

## API contract (`D` courier, `A` staff, `K` kitchen/merchant staff)

### Courier (additions to R1 shapes)
- `GET /driver/offers` → each offer adds:
  `readiness: { status: 'PREPARING'|'READY', estReadyAt|null, readyAt|null }`,
  `manifest: Manifest | null`, `market: { id, name } | null`, `policy.waitingCapMinutes`, `policy.dropoffGraceMinutes`.
- `GET /driver/jobs` → each job adds `readiness`, `manifest`, `shelfSlot` (once READY).
- `POST /driver/jobs/:id/transition` `PICKED_UP`: `pickupCheck.brands?: { brandKey, bagCount, sealIntact }[]`.
  It is required when `manifest.brands.length > 1`. Missing or short brands → 409 `MANIFEST_INCOMPLETE`
  `{ missing: brandKey[] }`; a brand with `sealIntact: false` → 409 `SEAL_BROKEN`. Accepting an offer while already
  carrying a non-batchable order → 409 `AT_CAPACITY`.
- `GET /driver/earnings` entries add `detail: { pickupWaitMinutes, dropoffWaitMinutes, kitchenDelayMinutes, marketId, marketVersion }`.

```ts
type Manifest = { brands: { brandKey: string /* brandId or 'location:<id>' */, brandName, orderId, orderNumber,
  items: { name, quantity, handling: string[] }[], bagCount, bagCodes: string[] }[],
  totals: { items: number, bags: number }, handling: string[], hasAlcohol: boolean }
```

### Kitchen / merchant (K, existing location access)
- `GET /locations/:id/courier-arrivals` → `{ jobId, orderId, orderNumber, status, courierFirstName|null, fleet, provider,
  etaToPickupMinutes|null, arrivedAt|null, estReadyAt|null, readyAt|null, shelfSlot|null, manifest }[]` (open jobs at the location or its kitchen).
- `POST /orders/:id/ready-estimate` `{ minutes }` (K) → kitchen pushes a new ready estimate (e.g. running late). Updates the job and resyncs the partner.

### Admin (`delivery.read` to view, `delivery.manage` to change)
- `GET /admin/delivery/policies` → `{ global: { pay, batching, readySync }, markets: { regionId, regionName, pay: Partial<CourierPayPolicy>, batching: Partial<BatchingConfig>, version, updatedAt, updatedBy }[], regions: { id, name, parentId }[] }`
- `PUT /admin/delivery/policies/markets/:regionId` `{ pay?, batching?, reason }` → row (version + 1, audited)
- `DELETE /admin/delivery/policies/markets/:regionId` `{ reason }`
- `GET /admin/delivery/policies/effective?locationId=` → `{ market: {id,name}|null, pay, batching, readySync }` (merged)
- `POST /admin/delivery/batching/preview` `{ jobId, withJobId }` → `{ batchable: boolean, reasons: string[] }`
- `GET /admin/delivery/reconciliation?provider=&from=&to=` → `{ rows: { jobId, orderNumber, provider, quotedCents, actualCents|null, cancelFeeCents, varianceCents, status, createdAt }[], totals: { quotedCents, actualCents, varianceCents, jobs } }`
- `POST /admin/delivery/providers/:name/test` → `{ ok, latencyMs, error|null, quote?: { feeCents, etaMinutes } }` (quotes a fixed pair of addresses at a chosen location; no delivery is created)
- Global settings remain `POST /admin/settings` keys `delivery.pay`, `delivery.batching`, `delivery.readySync`.

### DoorDash webhook
- `POST /webhooks/delivery/doordash` (existing route). Requires the `Authorization` header to equal
  `DOORDASH_WEBHOOK_SECRET` (configured as the webhook "Authorization" value in the DoorDash portal). Otherwise → 401.
  When the secret is unset in production, webhooks are rejected.

## Data — migration 0027
- `delivery_jobs` + `est_ready_at`, `ready_at`, `hold_until`, `ready_estimate_shown_at_accept`, `kitchen_delay_minutes`,
  `manifest jsonb`, `market_id uuid`, `provider_fee_cents` (actual), `provider_cancel_fee_cents`,
  `provider_synced_ready_at`.
- `driver_earnings` + `detail jsonb`.
- `courier_market_policies` (`region_id` unique → regions, `pay jsonb`, `batching jsonb`, `version int`, `updated_by_id`, `updated_at`, `created_at`).
- Index `delivery_jobs (status, hold_until)` for the release job.

## Jobs
- Every minute (existing `delivery` lock): release held jobs whose `hold_until ≤ now` (offer round).
- Kitchen READY / refire / estimate → synchronous `DeliveryService.onKitchenUpdate(orderId, tx)`.

## Smoke (`courierR2`, after `courierR1`)
1. A multi-brand order at the shared demo kitchen goes to the platform fleet. Its offer is held while preparing.
   Kitchen READY releases it. The offer shows the manifest with 2 brands.
2. A pickup check without the second brand → 409 MANIFEST_INCOMPLETE. With both → PICKED_UP.
3. A market policy with a higher waiting rate → the earnings entry uses it, and `detail.marketVersion` matches.
4. Batching preview: alcohol job + normal job → not batchable, reason "ALCOHOL excluded".
5. DoorDash adapter unit test with stubbed fetch: create body has items/alcohol/pickup_time, 409 → lookup, webhook without the secret → rejected, `returned` → RETURNED, fee read back.
6. Reconciliation lists the mock partner job with its quoted cost.

## Not in R2
Grouping several orders of one checkout into one trip: checkout groups exist only for chef orders, one per chef
location, and chef locations don't share kitchens, so there is no case to group today (normal batching still applies).
Forecasting, incentive campaigns, fraud review, automated reconciliation postings (R2 only reports variance),
instant payouts, specialised categories, Uber Direct changes beyond the shared interface.
