# Courier Release 4 — specialised categories

Started 2026-11-21. Builds on Courier R1 (4b6838c, 8eb50de), R2 (f7c68ee, dec1665) and R3 (05d4558, 7c28e03).
Release 4 of the driver spec. The user chose all four category groups:
alcohol / age-restricted, catering / large orders, pharmacy / sensitive, temperature-controlled / high-value.

## Gaps found in the current code
- **Alcohol.** A job with an `ALCOHOL` item needs a courier with the `ALCOHOL` capability, which staff tick by hand.
  There is no certification and nothing expires. At handoff the courier only sends `idChecked: true`: no date of birth,
  no age computed, no ID type, and no delivery-hours rule. The only refusal is the R1 trip issue `ID_CHECK_FAILED`,
  which has a single reason. Nobody confirms that the kitchen got the returned items back.
- **Catering.** `LARGE_ORDER` (> 10 items or ≥ $150) is a hard requirement with nothing behind it. It has no vehicle
  rule, setup time, setup pay, drop-off item checklist or recipient signature, and it ignores scheduled times.
- **Pharmacy / sensitive.** Nothing models it. Items have no flag, so these orders can be left in a safe place,
  handed over with a photo only, batched, and returned with no chain of custody.
- **Temperature / high value.** `COLD_BAG` is a soft preference. Nothing limits transit time or records a temperature,
  and nothing raises a breach. A $500 order can go to a courier on their first day and be left at the door with a
  photo.
- **Pay.** Couriers earn nothing extra for the extra work.

## What Release 4 adds

| Area | Addition |
|---|---|
| Categories | Five job categories, computed at dispatch next to the R1 requirements: `ALCOHOL` (tax category ALCOHOL), `CATERING` (group/tray order, subtotal ≥ `catering.minSubtotalCents` 30000, or ≥ `catering.minItems` 30 items), `SENSITIVE` (item handling flag `SENSITIVE`), `TEMP_CONTROLLED` (item handling flag `TEMP_CONTROLLED`), `HIGH_VALUE` (subtotal ≥ `highValue.thresholdCents` 25000). They are stored in `delivery_jobs.requirements` like the R1 values. Every category is a hard requirement, and none of them is ever batched, except `TEMP_CONTROLLED`, which may batch with another order going the same way. |
| Certifications | `courier_certifications` per courier and category (`ALCOHOL`, `CATERING`, `SENSITIVE`, `TEMP_CONTROLLED`). The courier passes the category training (read, then answer every question correctly). CATERING and TEMP_CONTROLLED then become ACTIVE straight away. ALCOHOL also needs a certificate upload (responsible-service document), and SENSITIVE needs a passed SCREENING check. Both go to staff review, with the status PENDING. A certification expires after `certValidDays`, and the nightly job marks expired ones. Staff can grant, reject or revoke with a reason. The courier's `capabilities` follow the ACTIVE certifications, so the R1 dispatch filter keeps working. HIGH_VALUE has no certification: eligibility comes from tenure (`minDeliveries` 50, `minRating` 4.7, lifecycle ACTIVE, no open fraud case, account ≥ `minAccountDays` 14). |
| Dispatch | A courier needs each category's ACTIVE certification. CATERING also needs a vehicle in `catering.vehicleTypes` (CAR, VAN). TEMP_CONTROLLED also needs the COLD_BAG capability and an estimated trip (to pickup + to drop-off) ≤ `tempControl.maxTransitMinutes`. HIGH_VALUE needs the tenure rule. RESTRICTED couriers never get category jobs (as in R1). A scheduled CATERING order is offered `catering.dispatchLeadMinutes` (90) before its time, so a qualified courier is lined up early. |
| Pay | A per-category premium (`premiumCents`: ALCOHOL 100, CATERING 500, SENSITIVE 150, TEMP_CONTROLLED 100, HIGH_VALUE 200) is shown on the offer as `pay.specialCents` + `pay.special[]`. It is snapshotted at accept and paid on DELIVERED as one earning of kind `SPECIAL` (unique per job). Catering setup is added to it: setup minutes × `catering.setupPerMinuteCents` (20), capped at `catering.maxSetupMinutes` (30). Posted like delivery pay (`PLATFORM_EXPENSE_DELIVERY_SUBSIDY` → `DRIVER_PAYABLE`). Returned or failed jobs get no premium. |
| Age-restricted handoff | DELIVERED on an ALCOHOL job requires `ageCheck: { dob, idType, idLast4? }`. The age is computed from `dob` at the drop-off location's date. Under `alcohol.minAge` (21) gives 400 `UNDERAGE`, and the courier must refuse. `idType` must be in `alcohol.idTypes`. The old `idChecked: true` alone is accepted only when `alcohol.requireDob` is false. Handoff outside `alcohol.deliveryHours` (local to the location; default 08:00–23:00) gives 409 `ALCOHOL_HOURS`. The record (`special.ageCheck`: age, idType, last 4, checkedAt) is kept; the DOB itself is not stored. |
| Refused handoff | `POST /driver/jobs/:id/refuse-handoff { reason, note? }` for ALCOHOL / SENSITIVE / HIGH_VALUE jobs after pickup. Reasons: `UNDERAGE`, `NO_ID`, `ID_INVALID`, `INTOXICATED`, `RECIPIENT_MISMATCH`, `OUTSIDE_HOURS`, `SEAL_BROKEN`, `CUSTOMER_REFUSED`. The job becomes RETURNED (costOwner CUSTOMER, courier return pay), custody is set to COURIER until the kitchen confirms receipt, and a delivery event and a support incident (category `RESTRICTED_RETURN`) are created. The customer is notified. The R1 `ID_CHECK_FAILED` trip issue now goes through the same path with reason `NO_ID`. |
| Return chain of custody | The kitchen confirms receipt with `POST /delivery-jobs/:id/return-received { sealIntact, note? }` (merchant staff with location access, or delivery staff), which sets custody RETURNED, `special.returnReceived`. Returns not received within `returnReceiveHours` (2) raise an alert from the hourly job. |
| Sensitive handoff | DELIVERED on SENSITIVE requires a signature, the recipient's name (it must match the order's customer name: same last name and first initial, case- and accent-insensitive, unless `sensitive.requireNameMatch` is false) and `sealIntact: true`. Photo/PIN alone is refused (`SIGNATURE_REQUIRED`, `RECIPIENT_MISMATCH`). No SAFE_PLACE resolution (`SAFE_PLACE_NOT_ALLOWED`). |
| High-value handoff | DELIVERED on HIGH_VALUE requires the customer PIN (`PIN_REQUIRED`), and safe-place drop is not allowed. |
| Temperature | `POST /driver/jobs/:id/temperature { stage: 'PICKUP'|'DROPOFF', tempC }` logs readings in `special.temps`. For TEMP_CONTROLLED, DELIVERED computes the transit time (picked up → delivered). If transit > `maxTransitMinutes`, or a reading is outside `coldMaxC` (5 °C), the job gets `special.breach { kind: 'TRANSIT'|'TEMPERATURE', detail }`, and a support incident `TEMPERATURE_BREACH` (NORMAL) is opened for the remedy. The handoff itself is not blocked, but the courier sees a note. With `tempControl.requireReadings` on, DELIVERED needs a DROPOFF reading (`TEMP_READING_REQUIRED`). |
| Catering handoff | `POST /driver/jobs/:id/catering { setupStartedAt?, setupDoneAt?, checklist: { itemsCounted, utensils, labelsShown, setupDone }, headcount? }`. DELIVERED on CATERING requires a signature and `checklist.itemsCounted`. When `catering.setupRequired` (per order: the group order needs setup, or the setting default) is on, `setupDone` is required too. Setup minutes come from start/done (capped). |
| Customer | The order view gains `delivery.handoffRequirements: { ageCheck: { minAge } | null, signature, recipientName, pin, noSafePlace, temperatureControlled }`, so the order page says "Have a photo ID ready (21+)", "Signature required", "Only {name} can receive this order". |
| Compliance report | `GET /admin/delivery/special/report?from=&to=`: per category, jobs, delivered, refused (by reason), ID checks, temperature breaches, returns awaiting receipt, and premium paid. |

## Settings (`@gutad/shared`, setting `delivery.special`)
```ts
interface SpecialCategoriesConfig {
  premiumCents: Record<SpecialCategory, number>,            // ALCOHOL 100, CATERING 500, SENSITIVE 150, TEMP_CONTROLLED 100, HIGH_VALUE 200
  certValidDays: number,                                     // 365
  returnReceiveHours: number,                                // 2
  alcohol: { minAge: number, requireDob: boolean, idTypes: string[], deliveryHours: { start: string, end: string } },
                                                             // 21, true, [DRIVERS_LICENSE, STATE_ID, PASSPORT, MILITARY_ID], 08:00–23:00
  catering: { minSubtotalCents: number, minItems: number, vehicleTypes: string[], setupRequired: boolean,
              setupPerMinuteCents: number, maxSetupMinutes: number, dispatchLeadMinutes: number },
                                                             // 30000, 30, [CAR, VAN], false, 20, 30, 90
  sensitive: { requireNameMatch: boolean },                  // true
  tempControl: { maxTransitMinutes: number, coldMaxC: number, requireReadings: boolean },  // 45, 5, false
  highValue: { thresholdCents: number, minDeliveries: number, minRating: number, minAccountDays: number }, // 25000, 50, 4.7, 14
}
```
Menu item `handling` gains `SENSITIVE` and `TEMP_CONTROLLED` (`HANDLING_FLAGS`).

## API contract (`D` courier, `A` staff, `M` merchant)

### Courier
- `GET /driver/certifications` → `{ category, label, status: 'NONE'|'TRAINING'|'PENDING'|'ACTIVE'|'REJECTED'|'EXPIRED'|'REVOKED', expiresAt, note, needs: ('TRAINING'|'CERTIFICATE'|'SCREENING'|'VEHICLE'|'COLD_BAG')[], training: { title, body, questions: { q, options }[] } }[]` plus `highValue: { eligible, reason|null }`
- `POST /driver/certifications/:category/training { answers: number[] }` → certification (409 `TRAINING_FAILED` `{ wrong: number[] }`)
- `POST /driver/certifications/:category/certificate { fileUrl, expiresAt? }` (ALCOHOL; `fileUrl` is a `/files/<id>` the courier uploaded) → PENDING
- `GET /driver/offers` / `GET /driver/jobs`: `categories: SpecialCategory[]`, `pay.specialCents`, `pay.special: { category, label, cents }[]`, and `handoff: { ageCheck: { minAge, idTypes } | null, signature, recipientName, pin, sealCheck, noSafePlace, tempControl: { maxTransitMinutes, coldMaxC, requireReadings } | null, catering: { setupRequired, headcount|null } | null }`
- `POST /driver/jobs/:id/status` DELIVERED body adds `ageCheck?`, `recipientName?`, `sealIntact?`
- `POST /driver/jobs/:id/refuse-handoff { reason, note? }` → `{ job, outcome }`
- `POST /driver/jobs/:id/temperature { stage, tempC }` → `{ temps, breach|null }`
- `POST /driver/jobs/:id/catering { startSetup?, finishSetup?, checklist?: { itemsCounted, utensils, labelsShown }, headcount? }` → `{ catering, setupPayCents }` (the server stamps setup start/finish; finishing before starting → 409 `CATERING_SETUP`)

### Merchant / kitchen
- `POST /delivery-jobs/:id/return-received { sealIntact, note? }` → job (`M` with location access, or `delivery.manage`)
- `GET /locations/:id/delivery-returns` → refused orders still with the courier `{ jobId, orderNumber, courierFirstName, categories, refusal, since }[]`

### Admin (`delivery.read` view, `delivery.manage` change)
- `GET /admin/courier-certifications?status=&category=` → queue `{ id, driverId, driverName, category, status, certificateUrl (signed), trainingPassedAt, submittedAt }[]`
- `POST /admin/courier-certifications/:id/decide { decision: 'APPROVE'|'REJECT'|'REVOKE', reason, expiresAt? }`
- `POST /admin/couriers/:id/certifications { category, reason, expiresAt? }` (grant directly, e.g. migrated couriers)
- `GET /admin/couriers/:id/certifications` → `{ certifications[] (with signed certificateUrl), highValue: { eligible, reason, deliveries } }`
- `GET /admin/delivery/jobs/:id/special` → `{ categories, custody, status, special (age check without DOB, temps, breach, catering, refusal, return receipt), handoff }`
- `GET /admin/delivery/special/report?from=&to=`
- `POST /admin/delivery/special/sweep` (runs the hourly job: expire certifications, overdue returns)
- Settings: `delivery.special` via the existing `POST /admin/settings`

## Data — migration 0029
- `courier_certifications` (driver_id, category, status, training_passed_at, certificate_file_url, submitted_at, decided_by_id, decided_at, note, expires_at, timestamps; unique driver+category)
- `delivery_jobs.special jsonb` (`{ ageCheck, recipientName, sealIntact, temps[], breach, catering, refusal, returnReceived, premium }`)
- `driver_earnings` kind `SPECIAL` joins the unique per (job, kind) index.
- Incident categories `RESTRICTED_RETURN`, `TEMPERATURE_BREACH` (text column, no enum change).

## Jobs
- Hourly: expire certifications past `expires_at` (drop the capability, notify the courier) and alert on restricted returns not received within `returnReceiveHours`.

## UI
- Courier web + mobile: a **Certifications** screen (training quiz per category, certificate upload, status/expiry, high-value eligibility). Offers and jobs show category badges and the premium. Handoff gets an age check form (DOB + ID type, with the computed age shown), recipient name + signature + seal confirmation, temperature entry, a catering checklist with a setup timer, and **Can't hand over** with refusal reasons.
- Admin → Couriers: a **Certifications** review tab (certificate link, approve/reject/revoke) and a certifications card on the courier page with grant/revoke.
- Admin → Delivery: a **Special categories** tab (settings editor + compliance report). The job detail shows the special handoff record.
- Merchant (web + mobile kitchen): a "Returned restricted orders" list on the incoming couriers panel with **Confirm received**.
- Customer (web + mobile order page): handoff requirement notes.
- Menu item editor: the SENSITIVE and TEMP_CONTROLLED handling flags.

## Smoke (`courierR4`, after `courierR3`)
1. Certifications: training with a wrong answer gives 409 `TRAINING_FAILED`, all right makes CATERING ACTIVE and adds the capability. ALCOHOL training + certificate goes PENDING, staff approve makes it ACTIVE, revoke drops the capability. Expiry by sweep drops the capability.
2. Alcohol order: an uncertified courier gets no offer, a certified one does, with a premium on the offer. DELIVERED without `ageCheck` gives `ID_CHECK_REQUIRED`, a DOB under 21 gives `UNDERAGE`, and a valid one is DELIVERED with a SPECIAL earning and no DOB stored.
3. Refusal: an alcohol job refused `NO_ID` becomes RETURNED, custody COURIER, with an incident. The kitchen confirms receipt and custody becomes RETURNED. The overdue-return sweep raises an alert for one that wasn't received.
4. Sensitive: photo-only gives `SIGNATURE_REQUIRED`, a wrong name gives `RECIPIENT_MISMATCH`, SAFE_PLACE is refused, and a matching name + signature + seal is delivered.
5. High value: a new courier is not eligible (no offer), the tenure rule is met via a lowered setting, and DELIVERED without a PIN gives `PIN_REQUIRED`.
6. Temperature: a reading above coldMaxC records a TEMPERATURE breach plus an incident, and the handoff still succeeds.
7. Catering: a BIKE courier is skipped and a CAR courier is offered. DELIVERED without a checklist is refused. With setup on, the setup minutes are paid inside the SPECIAL earning, capped.
8. Batching: an alcohol/sensitive job never batches, and TEMP_CONTROLLED still can.
9. Customer order view shows `handoffRequirements`.

## Not in R4
Automated ID scanning (barcode/OCR) and third-party age verification. Prescriptions and regulated pharmacy workflows
(SENSITIVE covers sealed, named-recipient handoff only). IoT temperature probes (readings are entered by hand). Customer
restocking fee charges (the cost owner is recorded as CUSTOMER, as in R1 returns). Partner providers get the categories
as handling notes only (DoorDash `contains_alcohol` already exists).

## Build notes (decisions made while building)
- Categories are computed at dispatch, and catering's "setup required" and headcount are snapshotted then, so a later
  setting change doesn't move the goalposts for a trip in progress. The premium is snapshotted on the offer and kept at accept.
- Capabilities follow certifications (ACTIVE adds the capability; expiry, rejection and revocation remove it). The staff
  capability edit on the courier page still works as an override.
- Alcohol handoff hours use the pickup location's timezone; equal start and end means all day.
- Alcohol, sensitive and high-value orders can't be left in a safe place (`SAFE_PLACE_NOT_ALLOWED`, staff included).
- A refused handoff pays the R1 return pay, never the premium. Customer notification reuses `delivery.failed`.
- Certificates are uploaded as courier photos with purpose `CERTIFICATE` (viewed through 5-minute signed links).
- Smoke `courierR4` runs after `courierR3`, temporarily raises `offersPerRound` so earlier phases' couriers don't crowd
  out the test couriers, restocks the food hall, and puts the bowl's tax category / handling back afterwards.
