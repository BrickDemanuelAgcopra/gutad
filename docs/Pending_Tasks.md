# Pending tasks: Gutad Admin Platform

The plan is in [`ADMIN-PLATFORM-PLAN.md`](ADMIN-PLATFORM-PLAN.md). Finished work goes to [`Completed_Tasks.md`](Completed_Tasks.md).

**Rule:** when a task ships, delete its line here and add it to Completed_Tasks in the same commit, with the date, commit and what shipped on each surface.

**Legend:**
- `[new]`: the feature doesn't exist yet.
- `[improve]`: the feature exists and gets extended.
- `[fix]`: a defect found during the audit.
- Surfaces: `W` web, `M` mobile, `API` server only.
- Mobile shows monitoring, queues, approvals and quick actions. Bulk editors stay on web; mobile shows that data read-only and links to the web editor.

---

## Phase A: console foundation & security

Phase A shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 2.4c-M [new] SSO sign-in on mobile (system-browser OIDC flow via expo-auth-session). Mobile staff use password + MFA today · M
- [ ] 2.6-P [improve] Payout release goes through the approval engine (`PAYOUT_RELEASE`, two-person over `approvals.thresholds.payoutCents`). The engine and threshold are in place; the hook-up lands with 19.4 payout batches · API W M

---

## Phase B: executive dashboard, live ops, central orders

Phase B shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 1.6-L [improve] Contribution: use actual labor hours (`labor_entries`, then 23.3 attendance) instead of recipe labor minutes × the hourly rate, wherever a kitchen records them · API W M
- [ ] 1.V [verify] Look at the dashboard, live board and order pages in a browser and on a device. Only the build, HTTP checks and smoke have been run so far · W M

---

## Phase C: locations, merchants, brands

Phase C shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 5.1-L [improve] Location picker and approval limit when inviting merchant staff from the admin merchant page; the API accepts them, the admin form does not show them yet · W
- [ ] 6.3-S [improve] Settlement royalty accrual (`ProgramsService.accrueRoyalties`) uses the brand royalty rules instead of the flat bps (with 19.3) · API
- [ ] 4.3-T [verify] Smoke check for document expiry (needs a document upload in the smoke run) · API

---

## Phase D: menu, recipes, pricing

Phase D shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 7.7-M [improve] Include modifier groups and options in versioned menu documents (today versions cover categories and items; modifier groups change directly) · API W
- [ ] 8.5-K [improve] Enforce recipe batch limits and equipment requirements in kitchen sequencing (with 13.3) · API W M
- [ ] 9.5-X [new] External tax provider adapter (Avalara or TaxJar) behind the tax calculation; today the built-in rate table is used · API

---

## Phase E: customers, checkout, support

Phase E shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 11.6 [improve] Gift balance in the payment mix with a calculation breakdown (ships with 25.9 gift cards) · API W M
- [ ] 10.8-L [new] Cash and credit limits per customer (restriction kinds today: ordering block, promotions block, refund review) · API W
- [ ] 10.4-D [improve] Device fingerprint as a duplicate-account signal (today: normalized email, phone and address) · API W
- [ ] 10.3-P [improve] Real processor SetupIntent/tokenization for saved cards on web and mobile (test mode builds a mock token client-side; the API already rejects raw card numbers) · API W M
- [ ] 24.6-W [improve] Merchant and courier screens to dispute a ticket's responsibility (API and admin decision shipped; merchants use the case thread today) · W M

---

## Phase F: kitchen & packing

Phase F shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 13.7-L [improve] Auto-throttle for independent restaurants without a production kitchen (today they use the per-15-minute order throttle) · API W
- [ ] 13.8-P [new] Network ticket-printer integration (today: browser print of station tickets and bag labels) · API W
- [ ] 14.8-K [new] Dedicated full-screen kiosk ordering app/mode (the API, KIOSK channel, table/pager routing and runner view are live; customers use the QR/web menu) · W M

---

## Phase G: delivery

Phase G shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 15.3-R [improve] Road-network travel times from a routing provider (today: straight-line distance × minutes per km per zone) · API
- [ ] 16.2-U [improve] Direct file upload for courier documents to storage (today: a link to the scanned file) · API W M
- [ ] 16.7-P [improve] Courier payout runs from the payable balance (with 19.4 payout release) · API W M
- [ ] 17.1-R [new] Push-based live map updates (today: polling every 10–15 seconds) · API W M
- [ ] 17.9-M [improve] More than one partner provider at a time: failover between two configured third-party providers (today: own fleet → the configured provider) · API

---

## Phase H: payments, settlement, accounting

### 18. Payments & transaction operations
- [ ] 18.1 [improve] Payments console: authorizations, captures, voids, refunds and failures with filters · API W M
- [ ] 18.2 [new] Enabled payment methods per region or channel (settings), shown at checkout · API W
- [ ] 18.3 [improve] Combined gift balance + credits + card split recorded per payment (with 25.9) · API W
- [ ] 18.4 [improve] Retry controls on failed payments (capped), duplicate prevention report · API W
- [ ] 18.5 [improve] Partial refunds allocated back to original methods (card / credits / gift balance) · API W
- [ ] 18.6 [improve] Processor settlement file upload and unresolved-payment queue in admin · API W M
- [ ] 18.7 [new] Disputes table: deadlines, evidence submission status, outcome, ledger posting · API W M
- [ ] 18.8 [improve] Webhook monitor (rate, failures, lag) and safe replay with a dry-run check · API W M
- [ ] 18.9 [improve] Card data never shown or typed raw; web checkout card field only uses the provider token flow, and masked display everywhere · W M

### 19. Merchant settlement, royalties & courier payouts
- [ ] 19.1 [improve] Ledger explorer (filter by account, party, order) · API W
- [ ] 19.2 [improve] Merchant earnings statement with contractual deductions itemized · API W M
- [ ] 19.3 [improve] Brand royalty and creator revenue-share statements (uses 6.3 rules) · API W M
- [ ] 19.4 [new] Payout batches with approval (two-person over threshold) before submission · API W M
- [ ] 19.5 [improve] Payout reconciliation against processor transfer reports and bank lines · API W
- [ ] 19.6 [improve] Failed or held payouts: manual reprocess, release after bank info is corrected · API W M
- [ ] 19.7 [new] Manual adjustments with a reason (ledger-posted) and merchant statement disputes · API W M
- [ ] 19.8 [improve] Liabilities report: merchant, driver, provider payables vs platform revenue · API W M
- [ ] 19.9 [new] Bank-account change verification: two-person approval + cooling-off hold before funds release · API W M

### 20. Accounting, treasury & financial control
- [ ] 20.1 [new] Chart-of-accounts mapping (ledger account → GL code per legal entity) and journal export · API W
- [ ] 20.2 [new] P&L by location, brand, channel and legal entity · API W M
- [ ] 20.3 [improve] Food, labor, delivery and processing cost reporting (COGS posted from recipes) · API W
- [ ] 20.4 [new] Gift-card liability and outstanding promotional credit report; credit-expiry breakage posting · API W
- [ ] 20.5 [new] Subscription revenue recognition schedule (deferred revenue) and refund adjustments · API W
- [ ] 20.6 [new] Supplier accounts payable (bills from 21.8) and corporate accounts receivable aging · API W
- [ ] 20.7 [new] Cash forecast, bank reconciliation view, month-end close checklist · API W M
- [ ] 20.8 [new] Budgets by cost center, approval limits view, financial audit export (ledger + audit CSV) · API W

---

## Phase I: supply, safety, workforce

### 21. Inventory, procurement & warehouse
- [ ] 21.1 [improve] Item masters: type (ingredient, prepared component, packaging, consumable), org ownership · API W
- [ ] 21.2 [new] Units of measure and conversions; expected consumption from recipes · API W
- [ ] 21.3 [new] Storage locations (warehouse, kitchen, storage area) and lots · API W M
- [ ] 21.4 [new] Stock movements ledger: receiving, transfers, counts, adjustments, spoilage · API W M
- [ ] 21.5 [new] Expiry dates and first-expiring-first-out picking suggestions · API W M
- [ ] 21.6 [new] Demand forecast (moving average by weekday), safety stock, replenishment proposals → draft PO · API W
- [ ] 21.7 [new] Supplier records, PO delivery schedules, receiving discrepancies · API W M
- [ ] 21.8 [new] Three-way match: PO ↔ receipt ↔ supplier invoice, with variance tolerance · API W
- [ ] 21.9 [new] Warehouse pick, pack, ship and receiving confirmation for inter-site transfers · API W M
- [ ] 21.10 [improve] Stockout → menu availability, and **auto-restore** on receipt · API
- [ ] 21.11 [new] Reports: forecast accuracy, waste, supplier performance, inventory valuation · API W M

### 22. Food safety, quality & recalls
- [ ] 22.1 [new] Approved suppliers and product specifications · API W
- [ ] 22.2 [new] Receiving and storage temperature logs with out-of-range alerts · API W M
- [ ] 22.3 [new] Checklist templates (cleaning, opening, closing, food handling) and signed completions · API W M
- [ ] 22.4 [improve] Allergen controls: recipe-change review (with 8.8) · API W
- [ ] 22.5 [new] Lot traceability: ingredient lot → kitchens/locations → orders · API W M
- [ ] 22.6 [new] Quarantine, withdrawal and recall workflow (stop-sell affected items, notify affected customers) · API W M
- [ ] 22.7 [new] Food-quality and illness incident escalation (FOOD_SAFETY category → food-safety owner, immediate alert) · API W M
- [ ] 22.8 [new] Inspection records, corrective actions, completion evidence · API W M

### 23. Workforce, training & equipment
- [ ] 23.1 [new] Staffing forecast from order volume; shift schedules by station and location · API W M
- [ ] 23.2 [new] Skills, training completion, role eligibility (a station requires a skill) · API W M
- [ ] 23.3 [new] Attendance (clock in/out) and payroll export · API W M
- [ ] 23.4 [new] Labor hours vs order volume report · API W M
- [ ] 23.5 [new] Equipment register, maintenance schedules, service tickets · API W M
- [ ] 23.6 [new] Equipment outage → affected menu items unavailable and station capacity reduced · API W M
- [ ] 23.7 [improve] Device health: kiosks, KDS, printers, scanners (kinds, last seen, firmware, alerts) · API W M
- [ ] 23.8 [new] Automated kitchens: approved software versions, fault alerts, maintenance, operator escalation (record/alert only; no actuation) · API W M

---

## Phase J: growth

### 25. Promotions, rewards, referrals & memberships
- [ ] 25.1 [improve] Automatic (codeless) offers as well as coupons · API W M
- [ ] 25.2 [improve] Eligibility: customer segment, first order, merchant, item/category, daypart/day-of-week · API W
- [ ] 25.3 [improve] Stacking rules (exclusive vs stackable, priority) · API W
- [ ] 25.4 [improve] Funding accounting split (with 9.6) and a promotion cost report · API W
- [ ] 25.5 [fix+improve] Referrals: reward after the referee's first completed order; abuse review (same device, payment or address) · API W M
- [ ] 25.6 [new] Reward challenges (e.g., 3 orders in 14 days), qualifying orders, progress, credit expiry · API W M
- [ ] 25.7 [improve] Membership trials, renewals, cancel at period end · API W M
- [ ] 25.8 [fix+improve] Failed recurring-payment recovery: PAST_DUE retries with backoff and a card update · API W M
- [ ] 25.9 [new] Gift cards: issuance, redemption at checkout, balances, liability, fraud controls (velocity, lock) · API W M
- [ ] 25.10 [new] Campaign profitability and incremental orders (holdout group) · API W M

---

## Cross-cutting (every phase)
- [ ] X.1 Migrations, seed data for every new module, smoke checks
- [ ] X.2 `docs/CAPABILITY-MAP.md` updated per phase
- [ ] X.3 Typecheck shared, API, web and mobile clean per phase
