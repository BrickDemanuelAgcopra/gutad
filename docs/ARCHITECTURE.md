# Gutad architecture notes

## Three independent axes

Every order carries `channel` (MARKETPLACE / DIRECT / WIDGET / QR / PARTNER / PHONE / WALK_IN / CAMPUS / CORPORATE / API), `organizationId` + the location's `legalSellerId` (who earns the food revenue and receives payout), and `locationId` + optional `kitchenId` (where the work happens). Fees are resolved from the **contract in force for the location at order time** (`ContractsService.termsFor`) and frozen into the order's `priceSnapshot`; later contract changes never alter historical orders.

## Money: double-entry ledger

`LedgerService.post()` writes a balanced batch of `journal_entries` (debits == credits, enforced). Accounts: `PROCESSOR_CLEARING`, `MERCHANT_PAYABLE`, `DRIVER_PAYABLE`, `PROVIDER_PAYABLE`, `TAX_PAYABLE`, `DEPOSIT_LIABILITY`, `CUSTOMER_CREDIT_LIABILITY`, `BANK`, and `PLATFORM_REVENUE_*` / `PLATFORM_EXPENSE_*`.

Order capture (marketplace delivery example, $40 food + $4 tax + $3 delivery + $5 tip, 15% commission):

| Dr | Cr | Account |
|---|---|---|
| 5200 | | PROCESSOR_CLEARING |
| | 3800 | MERCHANT_PAYABLE (food + tax − commission) |
| | 600 | PLATFORM_REVENUE_COMMISSION |
| | 300 | PLATFORM_REVENUE_DELIVERY (retail delivery fee) |
| | 500 | DRIVER_PAYABLE (tip, keyed `order:<id>` until a courier is known) |
| 180 | 180 | PLATFORM_EXPENSE_PROCESSING / PROCESSOR_CLEARING |

When the job is delivered, provider cost (partner fleet) or driver base pay (own fleet) is posted against `PLATFORM_EXPENSE_DELIVERY_SUBSIDY`, and the tip moves to the provider/driver. When another party funds a discount or remits tax, the **beneficiary line changes; the order total never does.** Refunds debit the funder (`MERCHANT_PAYABLE`, `PLATFORM_EXPENSE_REFUND`, `PROVIDER_PAYABLE` or `DRIVER_PAYABLE`) and credit clearing, so a refund after payout simply nets on the next statement (negative balances carry forward un-reconciled).

Weekly settlement (`SettlementService.closePeriod`) builds the statement **from the ledger**, creates a payout for positive balances, marks entries reconciled, and `submitPayouts` transfers via the payment provider with an idempotency key per payout. Bank lines and processor settlement files are matched by amount/charge id; mismatches go to `unmatched_items`.

### Gutad Chef Network: prepaid orders

Chef orders are sold by Gutad and **charged in full at checkout** (a platform charge, never a destination charge), because they are often booked more than 7 days ahead, longer than a card authorization lasts. The money is held per order in `DEFERRED_REVENUE` until the order is completed, so weekly settlement only ever pays chefs for finished orders. One checkout can pay for several chef orders; `order_payment_allocations` splits the payment so each order is refunded on its own.

Charge (two chef orders, $26.13 and $15.00, processor fee $1.50):

| Dr | Cr | Account |
|---|---|---|
| 4113 | | PROCESSOR_CLEARING |
| | 2613 | DEFERRED_REVENUE (party `order:<A>`) |
| | 1500 | DEFERRED_REVENUE (party `order:<B>`) |
| 150 | 150 | PLATFORM_EXPENSE_PROCESSING / PROCESSOR_CLEARING |

Completion (pickup, delivery, no-show, or a 1-minute catch-up job; `orders.recognized_at`): the order's remaining deferred amount is split like a captured order. The chef's `MERCHANT_PAYABLE` gets food + tax − commission; Gutad's commission and Chef Network customer fees go to `PLATFORM_REVENUE_*`; tips and delivery follow the usual rules.

| Event | Entries |
|---|---|
| Chef declines, or doesn't confirm by `accept_by` | Dr DEFERRED_REVENUE / Cr PROCESSOR_CLEARING, full amount (automatic refund) |
| Customer cancels before the date's cutoff | same, full amount |
| Customer cancels after the cutoff | the refund (chef's late-refund %) as above; the kept part is recognized like a completion, so the chef is paid for it |
| Customer changes the order before the cutoff | the new order is charged (new deferred balance) and the original is refunded in full, in one transaction |
| Staff adjustment | Dr PLATFORM_ADJUSTMENTS / Cr MERCHANT_PAYABLE (credit), or the reverse (charge) |

Chef Network fees and commission come from the approval-gated setting `fees.chef_network`, not from the location's contract, and are frozen into the quote snapshot like any other fee.

## Lifecycles (money has its own status)

| Record | Canonical | Branches |
|---|---|---|
| Order | SUBMITTED → ACCEPTED → PREPARING → READY → COLLECTED → COMPLETED | REJECTED (hold released), CANCELED (void or refund with cost owner), line-level UNAVAILABLE → REPLACED / CREDITED. Chef orders: prepaid, REJECTED when unconfirmed by `accept_by`, CANCELED + `amended_from_order_id` on the replacement when changed |
| Chef special request | PENDING → QUOTED → ACCEPTED → ORDERED | NEEDS_INFO (chef question), DECLINED, WITHDRAWN, EXPIRED, CLOSED (staff) |
| Payment | REQUIRES_ACTION → AUTHORIZED → CAPTURED → SETTLED | VOIDED, PARTIALLY_REFUNDED, REFUNDED, DISPUTED |
| Reservation | HELD → CONFIRMED → ARRIVED → SEATED → COMPLETED | EXPIRED, CANCELED, NO_SHOW (deposit forfeit or guarantee charge) |
| Delivery | QUOTED → REQUESTED → ASSIGNED → PICKED_UP → DELIVERED | QUOTE_EXPIRED, UNASSIGNED, CANCELED, FAILED, RETURNED — each with `costOwner` |
| Payout | ACCRUED → ELIGIBLE → SUBMITTED → PAID → RECONCILED | HELD (no account), FAILED (retry with backoff) |

Authorization happens at checkout; **capture happens on merchant acceptance**, so a rejected order never captures money and never creates a kitchen ticket. Gutad Chef Network orders are the exception: charged at checkout, held as deferred revenue, refunded automatically when the chef declines or doesn't confirm.

## Reliability rules

- **Idempotency**: every side-effecting endpoint accepts `Idempotency-Key`; replays return the stored response (`IdempotencyInterceptor`). Checkout, delivery dispatch, external-order dispatch, payouts and provider calls carry their own domain keys (`orders.idempotencyKey`, `delivery_jobs.idempotencyKey`, `payout:<id>`), so a retried checkout returns the same order and a lost provider response is looked up by external id before retrying (`findByExternalId`).
- **Outbox**: domain events are written in the same transaction as state (`outbox_events`) and relayed by the worker into deduplicated, consent-aware notifications (`notifications.dedupeKey`).
- **Inbox**: provider callbacks are stored once per `(provider, eventId)` and applied with out-of-order protection; failed ones are replayable from the admin portal.
- **Oversell protection**: reservations take a per-location advisory lock (`pg_advisory_xact_lock`) while checking table/time overlaps and slot pacing; ticket sessions and meal-kit stock use `SELECT … FOR UPDATE`. Chef kitchens lock per kitchen and service date: a quote holds portions in `kitchen_capacity_ledger` for 10 minutes and checkout re-checks and confirms them in its transaction.
- **Worker safety**: every scheduled job takes a Redis lock, and every job body is idempotent, so multiple workers or a crash mid-run are safe.
- **Tenant isolation**: JWT carries org memberships + location scopes; `assertOrgAccess` is applied on every merchant route; platform roles are explicit.
- **Secrets**: integration credentials are AES-256-GCM encrypted at rest; webhook payloads are HMAC-verified; fee/payout settings need a second approver; audit log + config history on every privileged change.

## Capability modules

See `docs/CAPABILITY-MAP.md` for the blueprint's 30 capabilities → modules → endpoints, and `docs/CHEF-NETWORK-PLAN.md` for the Gutad Chef Network.
