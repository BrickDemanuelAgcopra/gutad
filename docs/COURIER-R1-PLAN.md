# Courier Release 1 — driver onboarding, dispatch, handoff, earnings, reviews

Started 2026-11-20. Builds on Admin Phase G (zones, dispatch scoring, offers, batching, failover, documents, shifts,
exceptions, proof retention). Release 1 of the driver spec: "complete operational foundation".

## What already existed (Phase G) and stays
Zones/restrictions/coverage, scored offer rounds + batching + partner failover, first-accept-wins assignment,
documents with review/expiry, shifts, customer-unreachable wait timer, proof retention, live map, payouts of
`DRIVER_PAYABLE` through weekly settlement, partner providers (Uber Direct / DoorDash Drive) with webhooks.

## What Release 1 adds

| Area | Addition |
|---|---|
| Onboarding | 10-step wizard (location → equipment) + submit; application status separate from lifecycle; recruitment capacity → waitlist |
| Eligibility | `courier_eligibility` rows per check (IDENTITY, VEHICLE, SCREENING, PAYOUT, AGREEMENT, TRAINING, EQUIPMENT), each passes/fails/expires on its own |
| Decision | approve / needs action / waitlist / reject / reopen, approval needs every check PASSED + documents for the vehicle type |
| Lifecycle | ACTIVE / RESTRICTED / SUSPENDED / DEACTIVATED / REACTIVATION_PENDING |
| Starting work | on-demand or reserved (shift check-in), dispatchability reasons, break, finish-after-current, time tracking (online/break/active/waiting) |
| Offers | guaranteed pay breakdown, tip separate, stops, distance/duration, drop-off area only before accept, waiting/return/cancel policy, equipment; pay policy snapshot kept on the job |
| Pickup | required pickup check (bag count, seal, order code), custody tracking |
| Handoff | photo / PIN / signature evidence; ID check required for alcohol; customer sees the PIN |
| Trip problems | order not ready, restaurant closed, missing items, damaged packaging, already collected, vehicle breakdown, cannot continue, unsafe, ID check failed; release before pickup |
| Earnings | itemized (base, distance, time, waiting, return, cancel comp, tip), unique per job+kind, pending vs available, daily/weekly statements, payouts with failure reasons, payout account change needs password, earnings disputes |
| Reviews | customer rates delivery (1–5 + tags + comment) separately from food/packaging; issues → support case; moderation; kitchen-delay and sealed-bag exclusions; driver sees anonymised feedback and can dispute |
| Admin | onboarding pipeline + funnel, per-check decisions, lifecycle, review moderation queue, masked payout details |

## API contract (all JSON; `D` = courier token, `C` = customer, `A` = staff)

### Courier onboarding
- `GET /driver/onboarding` (D) → `Onboarding`:
  ```ts
  { driver: { id, applicationStatus, lifecycleStatus|null, status, vehicleType, decisionNote|null, submittedAt|null, firstDeliveryAt|null } | null,
    steps: { key: OnboardingStepKey, label, done: boolean, needsAction: boolean, note?: string }[],
    checks: { check: EligibilityCheck, status: CheckStatus, note|null, expiresAt|null }[],
    data: { location?, profile?, vehicle?, screening?: { consentVersion, consentedAt }, payout?: { method, accountLast4, taxFormAcceptedAt }, agreement?: { version, acceptedAt }, training?: { [moduleKey]: completedAtIso }, equipment?: { items: EquipmentItem[], photoUrl? } },
    requiredDocs: string[], documents: { id, kind, status, expiresAt, reviewNote }[],
    availability?: { serviceable: boolean, waitlist: boolean, message: string },
    canSubmit: boolean, missing: string[] }
  ```
  Without a driver row: `driver: null`, steps all not done.
- `POST /driver/onboarding/location` `{ country, city, zoneIds?: uuid[], transport: VehicleType }` → Onboarding (creates the DRAFT driver).
- `POST /driver/onboarding/profile` `{ legalName, addressLine1, city, postalCode, phone, languages: string[], photoUrl? }`
- `POST /driver/onboarding/vehicle` `{ make?, model?, plate?, color?, year? }` (plate+make+model required for CAR/VAN/SCOOTER)
- `POST /driver/onboarding/screening` `{ consent: true, consentVersion }`
- `POST /driver/onboarding/payout` `{ accountHolder, accountLast4 (4 digits), taxFormAccepted: true, password? }` (password required when changing an existing account)
- `POST /driver/onboarding/agreement` `{ version, accept: true }`
- `POST /driver/onboarding/training` `{ module: TrainingModuleKey, answer: number }` → 400 `WRONG_ANSWER` if wrong
- `POST /driver/onboarding/equipment` `{ items: EquipmentItem[], photoUrl? }`
- Identity/vehicle documents use the existing `POST /driver/documents/upload` (multipart) or `POST /driver/documents` `{ kind, fileUrl, expiresAt? }`.
- `POST /driver/onboarding/submit` → Onboarding (SUBMITTED→VERIFICATION_PENDING, or WAITLISTED when the city is closed/full). 400 `ONBOARDING_INCOMPLETE` with `missing`.
- `POST /driver/reactivation` `{ note }` (DEACTIVATED → REACTIVATION_PENDING)

### Courier work
- `GET /driver/status` (D) → `{ dispatchable, reasons: string[], isAvailable, mode: 'ON_DEMAND'|'RESERVED', onBreak, finishAfterCurrent, onlineSince|null, activeJobs, firstDeliveryAt|null, lifecycleStatus, applicationStatus, today: { onlineMinutes, breakMinutes, activeMinutes, waitingMinutes, deliveries, earningsCents } }`
- `POST /driver/availability` `{ isAvailable, lat?, lng?, mode? }` (existing; now records time and enforces eligibility)
- `POST /driver/break` `{ on: boolean }`
- `POST /driver/finish-after-current` `{ on: boolean }`
- `POST /driver/shifts/:id/check-in` `{ lat, lng }` → shift (`status: 'CHECKED_IN'`), courier online in RESERVED mode
- `GET /driver/offers` → `Offer[]`:
  ```ts
  { id, deliveryJobId, expiresAt, payCents, pay: { baseCents, distanceCents, timeCents, totalCents }, tipCents,
    stops: number, pickup: { name, line1, city }, dropoffArea: { city, postalCode }, distanceKm, toPickupKm, estMinutes,
    requirements: string[], equipment: string[], policy: { version, waitingGraceMinutes, waitingPerMinuteCents, returnCents, cancelAfterArrivalCents }, batchWith: string|null }
  ```
- `POST /driver/offers/:id` `{ accept }` (existing)
- `GET /driver/jobs` (existing) → jobs now also carry `pickupCheck`, `custody`, `payPolicy`, `issues`, `requiresIdCheck`, `pinRequired`, `orderCode` (last 4 of the order number, for matching at pickup)
- `POST /driver/jobs/:id/transition`
  - `PICKED_UP`: `{ status, pickupCheck: { orderCode?, bagCount, drinkCount?, sealIntact, note? }, lat?, lng? }` (pickupCheck required; `sealIntact:false` → 409 `SEAL_BROKEN`, report DAMAGED_PACKAGING)
  - `DELIVERED`: `{ status, proofPhotoUrl? | proofSignature? | handoffPin?, idChecked?, lat?, lng? }`; wrong PIN → 400 `PIN_MISMATCH`; alcohol without idChecked → 400 `ID_CHECK_REQUIRED`
- `POST /driver/jobs/:id/release` `{ reason }` (before pickup only; job re-offered, history kept)
- `POST /driver/jobs/:id/issue` `{ kind: TripIssue, note?, photoUrl? }` → `{ job, outcome: string, incidentId?: string }`
- `GET /driver/earnings` → `{ payableCents, pendingCents, availableCents, policy, entries: { id, kind, deliveryJobId, baseCents, distanceCents, timeCents, waitingCents, returnCents, tipCents, bonusCents, totalCents, reason, availableAt, createdAt }[], days: { date, cents, deliveries }[], weeks: { weekStart, cents, deliveries }[], payouts: { id, amountCents, status, failureReason, periodStart, periodEnd, paidAt }[], payoutAccount: { method, accountLast4 } | null }`
- `POST /driver/earnings/dispute` `{ deliveryJobId?, note }` → incident
- `GET /driver/feedback` → `{ ratingAvg|null, ratingCount, tagCounts: Record<string, number>, recent: { id, rating, tags, comment|null, createdAt, excluded: boolean, disputeStatus }[] }` (no customer identity)
- `POST /driver/feedback/:id/dispute` `{ note }`

### Customer
- Order view (`GET /orders/:id`) `delivery` now has `handoffPin` (while ASSIGNED/PICKED_UP) and `courierFirstName`.
- `GET /orders/:id/delivery-review` (C) → `{ eligible, reason|null, courierFirstName|null, review|null, editableUntil|null }`
- `POST /orders/:id/delivery-review` `{ rating: 1-5, tags?: string[], comment?, foodRating?: 1-5, packagingRating?: 1-5, issues?: ReviewIssue[] }` → review (upsert within 7 days; issues open support cases)

### Admin (`delivery.read` to view, `delivery.manage` to act; moderation also `support.manage`)
- `GET /admin/couriers/pipeline` → `{ counts: Record<ApplicationStatus, number>, funnel: { started, submitted, approved, firstDelivery }, applicants: { id, name, email, city, transport, applicationStatus, submittedAt, updatedAt, stalled, stepsDone, stepsTotal, checks: Record<EligibilityCheck, CheckStatus>, pendingDocs }[] }`
- `GET /admin/couriers/:id` (existing) adds `onboarding` (same shape as the courier's `GET /driver/onboarding`), `time` (last 7 days minutes by kind), `feedback` (as driver feedback + customer-safe), payout account masked unless `finance.read`.
- `POST /admin/couriers/:id/checks/:check` `{ status: 'PASSED'|'FAILED'|'NEEDS_ACTION'|'PENDING', note?, expiresAt? }`
- `POST /admin/couriers/:id/decision` `{ decision: 'APPROVE'|'NEEDS_ACTION'|'WAITLIST'|'REJECT'|'REOPEN', note }`
- `POST /admin/couriers/:id/lifecycle` `{ status: 'ACTIVE'|'RESTRICTED'|'SUSPENDED'|'DEACTIVATED', reason }`
- `GET /admin/delivery-reviews?status=PENDING_MODERATION|DISPUTED|ALL` → `{ id, deliveryJobId, orderId, driverId, driverName, rating, tags, comment, foodRating, packagingRating, issues, status, excluded, excludedReason, disputeStatus, disputeNote, history, createdAt }[]`
- `POST /admin/delivery-reviews/:id/moderate` `{ action: 'APPROVE'|'HIDE'|'EXCLUDE'|'RESTORE'|'UPHOLD_DISPUTE'|'REJECT_DISPUTE', note }`
- Pay policy, recruitment and availability rules: `POST /admin/settings` keys `delivery.pay`, `delivery.recruitment`, `delivery.availability`.

## Data
Migration 0026: `drivers` (+application_status, lifecycle_status, onboarding jsonb, decision fields, availability mode,
on_break, finish_after_current, first_delivery_at, rating_avg/count), `courier_eligibility`, `courier_time_entries`,
`delivery_reviews`, `delivery_jobs` (+handoff_pin, pickup_check, custody, pay_policy, issues), `driver_offers`
(+pay_breakdown), `driver_earnings` (+distance/time/waiting/return cents, available_at, unique per job+kind),
`courier_shifts` (+checked_in_at). Existing couriers are backfilled as APPROVED/ACTIVE with checks PASSED.

## Later releases (not in R1)
Kitchen-ready sync & multi-brand manifests, batching policy UI, waiting-pay policies per market, forecasting,
incentive campaigns, fraud review, extra providers, automated reconciliation, instant payouts, specialised categories.
