# Courier Release 3 — forecasting, incentive campaigns, fraud review, automated reconciliation, instant payouts

Started 2026-11-21. Builds on Courier R1 (4b6838c, 8eb50de) and R2 (f7c68ee, dec1665). Release 3 of the driver spec.
Release 4 (specialised categories) stays out.

## Gaps found in the current code
- **Forecasting.** Nothing predicts courier demand. `WorkforceService.staffingForecast` covers kitchen staff only.
  Courier shifts (`courier_shifts`) are booked without knowing expected orders, so ops can't see an under-supplied
  zone/hour before it happens.
- **Incentives.** The only courier extra pay is a manual BONUS/DEDUCTION (`DeliveryAdminService.payAdjustment`).
  There is no time- or zone-bound boost, no "N deliveries → bonus" quest, and no guaranteed hourly minimum.
  Offers don't show any incentive.
- **Fraud.** There are no signals. A courier can mark DELIVERED far from the dropoff, report impossible GPS jumps,
  reuse a proof photo, or keep releasing jobs after pickup arrival. Two couriers can share a payout account or phone.
  The same customer↔courier pair can keep tipping and rating each other. Nothing holds pay while staff review it.
- **Reconciliation.** R2 only *reports* partner fee variance. The provider invoice ingest
  (`SettlementService.ingestProviderInvoice`) matches on the exact `providerCostCents + tipCents`, so any DoorDash
  actual-fee difference goes to the unmatched queue. No ledger entry books variance or cancellation fees. Nothing
  checks that courier earnings, `DRIVER_PAYABLE` and courier payouts agree.
- **Payouts.** Couriers are paid weekly only (`closeDriverPeriod` → batch). There is no cash-out of available
  earnings.

## What Release 3 adds

| Area | Addition |
|---|---|
| Demand forecast | Expected delivery jobs per zone × hour for the next 7 days. Built from the last 8 weeks of the same weekday/hour with recency weighting, then scaled by the recent trend (last 14 days vs the 8-week mean). Supply = booked shifts + on-demand couriers expected from history. `gap = needed − supply`, with `needed = ceil(jobs / jobsPerCourierHour)`. Stored nightly in `courier_forecasts`, recomputed on demand. Forecast vs actual accuracy (MAPE) shown for the last 7 days. |
| Supply nudges | Zones/hours with a gap ≥ threshold appear as "Busy times" to couriers (web + mobile shift booking), optionally with a linked campaign. |
| Incentive campaigns | `courier_campaigns`, three kinds: **BOOST** (+cents or +% per delivery in zones/time window), **QUEST** (complete N deliveries in the window → bonus; tiers allowed), **GUARANTEE** (minimum earnings per online hour in the window, top-up paid at the end). Each has markets/zones, window, eligibility (min rating, vehicle types, lifecycle ACTIVE), a budget cap, and opt-in or automatic enrolment. Lifecycle DRAFT → SCHEDULED → ACTIVE → ENDED / CANCELED. Changing an active campaign is audited. |
| Incentive pay | BOOST is added to the offer pay breakdown (`incentiveCents` + campaign name) and stored on the job's pay snapshot. It is paid with the delivery earning (kind INCENTIVE, unique per job+campaign). QUEST and GUARANTEE settle when the window ends (job every 15 min) as one INCENTIVE earning per courier+campaign (idempotent). All incentive pay posts `PLATFORM_EXPENSE_COURIER_INCENTIVE` → `DRIVER_PAYABLE`. It stops at the budget, and spend is tracked per campaign. Couriers see active and joinable campaigns and their progress. |
| Fraud signals | `courier_risk_signals` are raised synchronously at the event: `GPS_JUMP` (implied speed > 200 km/h between pings), `DROPOFF_FAR` (DELIVERED > 300 m from the dropoff by the courier's last location), `PROOF_REUSED` (same proof file used on two jobs / same image hash), `RELEASE_PATTERN` (≥ 3 releases after pickup arrival in 7 days), `SHARED_PAYOUT` / `SHARED_PHONE` (another courier with the same payout account / phone), `COLLUSION` (same customer and courier ≥ 4 deliveries in 14 days with tips above 2× median), `INCENTIVE_GAMING` (quest deliveries much shorter than the market median, or on/offline flapping in a guarantee window), `UNREACHABLE_PATTERN` (≥ 3 customer-unreachable returns in 7 days). Each signal has a weight. Score = sum of open signal weights over 30 days. |
| Fraud review | When the score crosses `fraud.reviewThreshold`, a `courier_fraud_cases` row is opened (one open case per courier). Above `fraud.holdThreshold`, the courier's unpaid earnings are put on hold (they are excluded from payouts and instant cash-out). Staff queue with evidence (signals, jobs, map points, proof thumbnails, linked accounts). Decisions: CLEAR (release the hold, dismiss signals), WARN, CLAWBACK (DEDUCTION for chosen earnings), RESTRICT / SUSPEND (R1 lifecycle). Every decision needs a reason, is audited and is shown to the courier as a plain notice, with the R1 appeal flow available. |
| Automated reconciliation | Nightly per partner job: book `actual + cancel fee − quoted` as a variance entry (`PROVIDER_PAYABLE` ↔ `PLATFORM_EXPENSE_DELIVERY_VARIANCE`) once the actual fee is known. Idempotent per job (`delivery_jobs.reconciled_at`, `recon_variance_cents`). The provider invoice ingest matches by provider job id against the *expected* amount (actual if known, else quoted, plus tip and cancel fee) within a tolerance (`recon.toleranceCents`, default 50). Within tolerance it auto-matches and books the difference; outside it, the line goes to the unmatched queue as before. |
| Courier ledger integrity | Nightly check per courier: sum(earnings) − sum(paid payouts) − instant cash-outs = `DRIVER_PAYABLE` balance. Mismatches appear in Reconciliation as exceptions. |
| Instant payouts | A courier can cash out available (past `availableAt`, not on hold, not in a payout) earnings at any time. Fee (`payouts.instant.feeCents`, default 50), min 500, daily limit 3 / $500, account age ≥ 7 days since first delivery, payout account onboarded, no open fraud hold. Creates a payout `partyType DRIVER`, `kind INSTANT`, transfers immediately (idempotent key), and marks those earnings `payoutId`. Fee posts `DRIVER_PAYABLE` → `PLATFORM_REVENUE_INSTANT_FEE`. Weekly `closeDriverPeriod` skips entries already paid instantly. |

## Settings (`@gutad/shared`)
```ts
interface ForecastConfig {            // setting `delivery.forecast`
  lookbackWeeks: number,              // 8
  horizonDays: number,                // 7
  jobsPerCourierHour: number,         // 2.2
  gapAlertCouriers: number,           // 2 — show as "Busy time" when needed − supply ≥ this
}
interface FraudConfig {               // setting `delivery.fraud`
  reviewThreshold: number,            // 40
  holdThreshold: number,              // 70
  weights: Record<RiskSignalType, number>, // GPS_JUMP 15, DROPOFF_FAR 20, PROOF_REUSED 40, RELEASE_PATTERN 15,
                                      // SHARED_PAYOUT 50, SHARED_PHONE 25, COLLUSION 30, INCENTIVE_GAMING 30, UNREACHABLE_PATTERN 20
  dropoffFarMeters: number,           // 300
  maxSpeedKmh: number,                // 200
}
interface InstantPayoutConfig {       // setting `payouts.instant`
  enabled: boolean, feeCents: number, minCents: number, dailyCount: number, dailyMaxCents: number, minAccountAgeDays: number,
}
interface ReconConfig { toleranceCents: number }   // setting `recon` (key `delivery.recon`)
```

## API contract (`D` courier, `A` staff)

### Courier
- `GET /driver/busy-times?days=` → `{ zoneId, zoneName, hourStart, expectedJobs, gapCouriers, campaignId|null }[]`
- `GET /driver/campaigns` → `{ id, kind, name, description, windowStart, windowEnd, zones: {id,name}[], terms, enrolled, eligible, ineligibleReason|null, progress: { deliveries, onlineMinutes, earnedCents, targetDeliveries|null, nextTier|null, estimatedPayoutCents } | null }[]`
- `POST /driver/campaigns/:id/join` → enrolment (opt-in campaigns; 409 `NOT_ELIGIBLE` `{ reason }`)
- `GET /driver/offers` → `pay.incentiveCents`, `pay.incentives: { campaignId, name, cents }[]`
- `GET /driver/earnings` → kind `INCENTIVE` entries carry `detail.campaignId/campaign`; top-level `hold: { active, message }` (the hold is per courier, not per entry)
- `GET /driver/payouts/instant` → `{ enabled, availableCents, feeCents, minCents, remainingToday: { count, cents }, blockedReason|null, recent: Payout[] }`
- `POST /driver/payouts/instant` `{ amountCents? }` (default = all available) → payout `{ id, amountCents, feeCents, status, failureReason }`. Errors: 409 `INSTANT_UNAVAILABLE` `{ reason }`.
- `GET /driver/notices` → `{ hold, holdMessage, notices: { decision, notice, decidedAt }[] }` (plain text, no signal internals)

### Admin (`delivery.read` view, `delivery.manage` change; `finance.manage` for reconciliation postings)
- `GET /admin/delivery/forecast?zoneId=&from=&to=` → `{ cells: { zoneId, hourStart, expectedJobs, supplyCouriers, neededCouriers, gap }[], accuracy: { mape, days }, generatedAt }`
- `POST /admin/delivery/forecast/rebuild` `{ at? }` → `{ cells, zones, actualsFilled, generatedAt }` (`at` only with `ALLOW_BILLING_TIME_TRAVEL=true`, for tests)
- `GET /admin/courier-campaigns?status=` / `POST /admin/courier-campaigns` / `PUT /admin/courier-campaigns/:id` / `POST /admin/courier-campaigns/:id/{activate,cancel}` `{ reason }`
- `GET /admin/courier-campaigns/:id` → campaign + `{ spentCents, enrolled, participants: { driverId, name, deliveries, earnedCents }[] }`
- `POST /admin/courier-campaigns/sweep` (run the 15-minute campaign job now)
- `GET /admin/courier-fraud/cases?status=` → `{ id, driverId, driverName, score, status, holdActive, openedAt, topSignals }[]`
- `GET /admin/courier-fraud/cases/:id` → case + signals (with job, points, proof links) + linked couriers + held earnings
- `POST /admin/courier-fraud/cases/:id/decide` `{ decision: 'CLEAR'|'WARN'|'CLAWBACK'|'RESTRICT'|'SUSPEND', reason, clawbackEarningIds?: string[], noticeToCourier: string }`
- `POST /admin/couriers/:id/risk-signals` `{ type, note }` (manual signal) · `GET /admin/couriers/:id/risk` → `{ score, reviewThreshold, holdThreshold, openCaseId, holdActive }`
- `POST /admin/courier-fraud/sweep` (run the hourly pattern job now)
- `GET /admin/delivery/reconciliation` (R2) adds `providerJobId`, `tipCents`, `postedCents`, `reconciledAt` per row, `totals.postedCents/unposted` and `exceptions: { driverId, name, earningsCents, payoutsCents, ledgerCents, diffCents }[]`
- `POST /admin/delivery/reconciliation/run` → `{ posted, varianceCents, exceptions }` (runs the nightly job now)

## Data — migration 0028
- `courier_forecasts` (zone_id, hour_start, expected_jobs real, supply_couriers real, needed_couriers int, actual_jobs int null, generated_at; unique zone+hour)
- `courier_campaigns` (kind, name, description, status, market_ids uuid[], zone_ids uuid[], window_start, window_end, rules jsonb, eligibility jsonb, enrolment 'AUTO'|'OPT_IN', budget_cents, spent_cents, created_by_id, version, timestamps)
- `courier_campaign_enrolments` (campaign_id, driver_id, joined_at, settled_at, payout_cents; unique)
- `courier_risk_signals` (driver_id, type, weight, delivery_job_id null, data jsonb, status OPEN|DISMISSED|CONFIRMED, case_id null, created_at)
- `courier_fraud_cases` (driver_id, status OPEN|DECIDED, score, hold_active bool, decision, reason, notice, decided_by_id, decided_at, opened_at; partial unique open per driver)
- `driver_earnings` + `campaign_id uuid`, `held bool default false`; INCENTIVE unique per (job, campaign) and per (driver, campaign) when job null
- `delivery_jobs` + `reconciled_at`, `recon_variance_cents`
- `payouts` + `kind text default 'SCHEDULED'`, `fee_cents int default 0`
- Ledger accounts `PLATFORM_EXPENSE_COURIER_INCENTIVE`, `PLATFORM_EXPENSE_DELIVERY_VARIANCE`, `PLATFORM_REVENUE_INSTANT_FEE`.
- The GPS check uses the existing `drivers.last_lat/last_lng/last_seen_at` before they are overwritten; proof reuse uses the existing `stored_files.sha256`.

## Jobs
- Nightly 03:00: forecast rebuild (+ fill `actual_jobs` for past cells), reconciliation postings, ledger integrity.
- Every 15 min: campaign status transitions (SCHEDULED → ACTIVE → ENDED) and settlement of ended QUEST/GUARANTEE.
- Hourly: pattern signals (RELEASE_PATTERN, COLLUSION, UNREACHABLE_PATTERN, INCENTIVE_GAMING) over the last window.

## UI
- Admin → Delivery: **Forecast** tab (zone × hour heat grid for 7 days, gap highlighted, accuracy), **Campaigns** tab
  (list, create/edit with zone picker, participants, spend vs budget), **Reconciliation** tab gains posted/exception columns and "Run now".
- Admin → Couriers: **Fraud review** queue + case page (signals timeline, map points, linked accounts, decide dialog); risk score on the courier page.
- Courier web + mobile: Busy times on the shifts screen, Campaigns list with progress, offer shows boost, Earnings → "Cash out now" with fee and limits, hold notice.

## Smoke (`courierR3`, after `courierR2`)
1. Forecast: seed historical jobs for a zone/hour → rebuild → cell expectedJobs > 0; gap shows when no shifts are booked; `/driver/busy-times` lists it.
2. BOOST campaign in the demo zone → offer `pay.incentiveCents` = boost; after delivery an INCENTIVE earning exists, campaign `spentCents` grows; budget exhaustion stops boosts.
3. QUEST (target 1 delivery, window ending now) → settlement pays once; rerun pays nothing more.
4. GUARANTEE: online minutes with low earnings → top-up = minimum − earned.
5. Fraud: DELIVERED far from the dropoff → DROPOFF_FAR; reused proof → PROOF_REUSED; the score crosses the hold → case OPEN, earnings held, instant cash-out → 409 INSTANT_UNAVAILABLE; decide CLEAR → hold released.
6. Shared payout account between two couriers → SHARED_PAYOUT on both.
7. Instant payout: fee deducted, payout PAID (mock), earnings marked; weekly close skips them; daily limit enforced.
8. Reconciliation: partner job with actual fee ≠ quoted → run posts the variance once (second run posts 0); invoice line within tolerance auto-matches; ledger integrity reports no exceptions.

## Not in R3
Specialised categories (R4). ML forecasting (R3 uses weighted history). Device fingerprinting beyond phone/payout account.
Real-time surge pricing to customers (incentives are courier-side only).

## Build notes (decisions made while building)
- Instant cash-out does not mark earnings rows. It debits `DRIVER_PAYABLE` without a payout id and leaves the entry
  unreconciled, so the weekly close nets it automatically. Available = unreconciled balance − earnings still in their hold period.
- The fraud hold is per courier. While an open case holds payouts, `closeDriverPeriod` skips the courier and instant cash-out is refused.
- Shared payout account = same provider account id, or the same holder name (normalised) + last 4. Shared phone uses the profile phone, else the account phone.
- QUEST and GUARANTEE settle only for enrolled couriers when opt-in; AUTO quests pay everyone who delivered in the window.
- A live campaign can change only its name, description, budget and end time (409 `CAMPAIGN_LIVE` otherwise).
- Invoice ingest: within tolerance, a delivered job with no reported fee learns the fee from the invoice (the nightly run books the variance); otherwise the small invoice difference is booked at once.
