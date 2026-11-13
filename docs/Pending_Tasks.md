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

### 3. Food hall & location management
- [ ] 3.1 [improve] Location contacts (named list), coordinates, timezone and operating status editable in admin · API W M
- [ ] 3.2 [new] Holiday schedules and special hours for ordering (not only reservations), temporary closures with a scheduled reopening time · API W M
- [ ] 3.3 [improve] Channel availability: delivery, pickup, dine-in, **kiosk** flags · API W M
- [ ] 3.4 [improve] Brands and menus offered per location (assignment view) · API W M
- [ ] 3.5 [new] Station capacity (concurrent tickets), equipment availability, maximum orders per 15 minutes · API W M
- [ ] 3.6 [new] Launch checklist (configurable items) with sign-offs and a readiness approval before LIVE · API W M
- [ ] 3.7 [new] Pickup instructions, parking details, courier collection point (shown to customers and couriers) · API W M
- [ ] 3.8 [improve] Emergency pause from admin (single location or region) and a controlled restart (checklist, throttle ramp-up) · API W M

### 4. Merchant onboarding & lifecycle
- [ ] 4.1 [new] Merchant applications and a sales pipeline (lead → contacted → applied → approved → onboarding → live, or lost) · API W M
- [ ] 4.2 [improve] Business identity, owners/beneficial owners, contacts, payout-information collection · API W
- [ ] 4.3 [improve] Document expiry dates, an expiry reminder job, an outstanding-requirements list · API W M
- [ ] 4.4 [improve] Contract version history and negotiated terms view, acceptance records in admin · W
- [ ] 4.5 [improve] Participating locations and designated merchant admins managed from admin · API W
- [ ] 4.6 [new] Onboarding checklist: menu import, operational setup, training, test order (with an automatic test-order check) · API W M
- [ ] 4.7 [improve] Workflows for approve, activate, suspend, terminate and **reinstate**, with reasons and history · API W M
- [ ] 4.8 [new] Onboarding progress percentage and account-manager assignment · API W M

### 5. Merchant portal administration
- [ ] 5.1 [improve] Admin creates merchant accounts and assigns location access (members screen in admin) · API W
- [ ] 5.2 [new] Change-request review: merchant-submitted menu and business-information changes wait for approval when the setting is on · API W M
- [ ] 5.3 [improve] Order acceptance settings (auto-accept, acceptance timeout) and prep-time settings · API W M
- [ ] 5.4 [improve] Admin view of temporary item unavailability and store pauses across merchants · API W M
- [ ] 5.5 [improve] Order, fee, refund and settlement statement lines per order for merchants · API W
- [ ] 5.6 [new] Merchant support cases: merchants open cases, see complaints and disputes about them, and respond · API W M
- [ ] 5.7 [new] Merchant performance ranking: acceptance rate, cancellation rate, average prep time, error rate · API W M

### 6. Brand ownership & culinary partnerships
- [ ] 6.1 [new] Brand ownership type: COMPANY_OWNED, LICENSED, INDEPENDENT, CREATOR · API W M
- [ ] 6.2 [new] Brand rights: owner, operating rights, territories (regions), contract start and end dates · API W
- [ ] 6.3 [improve] Royalty and revenue-share rules (bps, per-item cents, tiers, minimum guarantee) instead of a flat bps · API W
- [ ] 6.4 [improve] Brand → authorized kitchens and distribution channels · API W
- [ ] 6.5 [new] Brand asset library (logo, photos, guidelines) and presentation standards · API W
- [ ] 6.6 [new] Partner recipe approvals and quality reviews (score, notes, pass/fail) · API W M
- [ ] 6.7 [new] Partner performance and earnings statements · API W M
- [ ] 6.8 [improve] Automatic stop-sell when rights expire or are suspended (job + quote check) · API W M

---

## Phase D: menu, recipes, pricing

### 7. Menu & product catalog
- [ ] 7.1 [improve] Serving size and photos management · API W
- [ ] 7.2 [improve] Reusable modifier groups shared across items; customization limits · API W
- [ ] 7.3 [improve] Nutrition (calories, macros); allergens derived from recipe ingredients, with manual override · API W M
- [ ] 7.4 [new] Location-specific assortment, price and availability overrides of a shared item · API W
- [ ] 7.5 [fix] Menu daypart schedule also enforced in checkout (`resolveItems` ignores it) · API
- [ ] 7.6 [new] Bundles and combos (fixed price, component choices), packaging options, beverages and extras flags · API W M
- [ ] 7.7 [new] Menu draft → review → publish, version snapshots, diff, rollback · API W M
- [ ] 7.8 [improve] Bulk import validation report, CSV/JSON export, duplicate detection · API W

### 8. Recipes & culinary production
- [ ] 8.1 [improve] Recipes owned by an org, editable in web UI (quantities, yield, portion size) · API W M
- [ ] 8.2 [new] Preparation steps and station-specific instructions · API W M
- [ ] 8.3 [improve] Recipe version history and approved ingredient substitutions · API W
- [ ] 8.4 [improve] Ingredient cost and dish profitability (price vs plate cost, margin %) · API W M
- [ ] 8.5 [new] Equipment requirements, prep time, batch limits · API W
- [ ] 8.6 [new] Test-kitchen trials (notes, score) and release approval before a recipe goes active · API W M
- [ ] 8.7 [new] Training materials per recipe and staff acknowledgment of recipe changes · API W M
- [ ] 8.8 [new] Traceability: ingredient allergens → recipe → menu item; a recipe change flags the affected items for review · API W

### 9. Pricing, fees & tax
- [ ] 9.1 [improve] Base price with authorized location and channel overrides (requires 7.4); changes over the threshold need approval · API W
- [ ] 9.2 [new] Configurable fee rules: delivery, service, small-order and packaging fees (replacing hard-coded service fee constants) · API W
- [ ] 9.3 [improve] Membership benefits and fee-waiver eligibility editable in admin · API W
- [ ] 9.4 [improve] Commission and royalty schedule views together · W
- [ ] 9.5 [new] Item tax categories, a `TaxProvider` interface (flat default; external adapter slot) · API W
- [ ] 9.6 [improve] Promotion funding split (platform % / merchant %) · API W
- [ ] 9.7 [new] Effective-dated price changes, approval workflow, price-change history · API W M
- [ ] 9.8 [new] Checkout-price simulator: run a sample cart against draft rules before publishing · API W

---

## Phase E: customers, checkout, support

### 10. Customer account management
- [ ] 10.1 [new] Admin customer directory and profile (addresses, contact preferences, account status) · API W M
- [ ] 10.2 [new] Customer 360: orders, complaints, refunds, credits, memberships, loyalty · API W M
- [ ] 10.3 [new] Payment-provider customer reference and masked saved cards (brand/last4 only) · API W M
- [ ] 10.4 [new] Account recovery assist and duplicate-account detection (same phone, email or device) with merge · API W
- [ ] 10.5 [improve] Marketing consent and per-channel/topic notification preferences (customer and admin) · API W M
- [ ] 10.6 [new] Platform segments and service-recovery eligibility (e.g., no more than N goodwill credits in 90 days) · API W
- [ ] 10.7 [improve] Privacy requests queue (export, deletion), retention policy job · API W M
- [ ] 10.8 [fix+new] Customer restrictions (ordering block, cash/credit limits) with reasons and an appeal flow; customer strikes take effect · API W M

### 11. Cart, checkout & order eligibility
- [ ] 11.1 [improve] Service-area and hours validation errors carry codes and next-open time · API W M
- [ ] 11.2 [improve] Item quantity limits per item (max per order) · API W M
- [ ] 11.3 [new] Shared `cartCompatibility()`: Made at Gutad menus mix in one cart when one platform-operated fulfillment location serves them all · API W M
- [ ] 11.4 [new] Separate-order enforcement: independent restaurants or incompatible locations → `SEPARATE_ORDER_REQUIRED`; carts explain why instead of silently clearing · API W M
- [ ] 11.5 [new] Scheduled-order slot capacity and cutoff checks · API W M
- [ ] 11.6 [improve] Gift balance in the payment mix (with 25.9); calculation breakdown shown · API W M
- [ ] 11.7 [improve] Payment-failure recovery: retry with a new card on the same order without a duplicate · API W M
- [ ] 11.8 [improve] Snapshot menu version, cancellation and refund policy version on each order · API

### 24. Customer support & service recovery
- [ ] 24.1 [improve] Tickets linked to payment and merchant (org) as well as order, reservation and delivery · API W M
- [ ] 24.2 [improve] Categories: WRONG_ITEM, QUALITY, FAILED_DELIVERY, FOOD_SAFETY, PAYMENT, plus the existing ones · API W M
- [ ] 24.3 [new] Response and resolution SLAs per category and priority, escalation queues, assignment and ownership · API W M
- [ ] 24.4 [improve] Refund, credit, remake and redelivery options with clear previews · W M
- [ ] 24.5 [fix+new] Duplicate-compensation prevention across tickets for the same order (partly done in Phase A: approval limits are enforced, and repeat compensation on an order always needs approval). Still to do: preview of prior compensation in the ticket UI, and a per-customer goodwill cap · API W M
- [ ] 24.6 [new] Merchant/courier responsibility review: they can dispute the assigned fault and admins rule on it · API W M
- [ ] 24.7 [new] Communication thread per ticket and approved response templates · API W M
- [ ] 24.8 [new] Root-cause report by dish, kitchen, merchant and delivery zone · API W M

---

## Phase F: kitchen & packing

### 13. Kitchen display & preparation
- [ ] 13.1 [improve] Item-level work tickets in the station queue (line status per item) · API W M
- [ ] 13.2 [improve] Station routing rules (by item, category or brand), with a default · API W
- [ ] 13.3 [new] Cook-time sequencing: per-item cook minutes → fire-at times so all items finish together · API W M
- [ ] 13.4 [improve] Order completion coordination view (which station is holding the order) · W M
- [ ] 13.5 [new] Prep targets per station, delay flags, completed-food waiting time · API W M
- [ ] 13.6 [new] Remakes, missing items and quality failures recorded with reason codes · API W M
- [ ] 13.7 [new] Auto-throttle: lower incoming capacity when queue load passes a threshold; restore on recovery · API W M
- [ ] 13.8 [new] Offline/degraded procedure: printable runbook, last-known queue cached on the device, manual ticket mode · W M

### 14. Packing, handoff, pickup & dine-in
- [ ] 14.1 [improve] Packing checklist for every order, including drinks, utensils and extras · API W M
- [ ] 14.2 [improve] Bag labels (printable), multiple bags per order with bag count tracking · API W M
- [ ] 14.3 [new] Handling flags: hot, cold, fragile, allergen-sensitive, from items onto bags and labels · API W M
- [ ] 14.4 [improve] Final packing verification for single-ticket orders as well · API W M
- [ ] 14.5 [new] Pickup shelves and holding slots, with an alert when an order has waited longer than X minutes · API W M
- [ ] 14.6 [improve] Handoff confirmation records who received it (courier id or customer code) · API W M
- [ ] 14.7 [new] Pickup no-show and abandoned-order job: notify, then hold, then resolve (refund or charge per policy) · API W M
- [ ] 14.8 [new] Kiosk channel and dine-in table routing (table number on the order, runner view) · API W M

---

## Phase G: delivery

### 15. Delivery areas, promises & capacity
- [ ] 15.1 [improve] Map-drawn zones with exclusion polygons (web map editor; mobile read-only map) · API W M
- [ ] 15.2 [new] Zone → kitchen and merchant assignments (a zone can serve several locations) · API W
- [ ] 15.3 [improve] Travel-time estimate, zone capacity and zone opening hours · API W
- [ ] 15.4 [improve] ETA uses kitchen load (prep) and courier availability · API W M
- [ ] 15.5 [new] Weather and disruption restrictions (shrink radius, add minutes, pause zone) with expiry · API W M
- [ ] 15.6 [new] Scheduled delivery windows with capacity per window · API W M
- [ ] 15.7 [improve] Fee and minimum-order rules by zone (tiered by distance) · API W
- [ ] 15.8 [new] Coverage simulation for a new location (grid sample → % covered, ETA, overlap with existing zones) · API W

### 16. Courier & delivery-partner management
- [ ] 16.1 [improve] Courier directory and profile, service areas (regions/zones), operational status · API W M
- [ ] 16.2 [new] Courier onboarding documents (license, insurance, background check) with review and expiry · API W M
- [ ] 16.3 [improve] Vehicle type enum and capabilities (alcohol, large orders, cold bag) used by dispatch · API W M
- [ ] 16.4 [new] Courier shifts and availability blocks; third-party provider connections listed per region · API W M
- [ ] 16.5 [new] Reliability metrics: acceptance, completion, cancellation, on-time rate · API W M
- [ ] 16.6 [new] Courier incidents, training records, support history · API W M
- [ ] 16.7 [improve] Compensation adjustments (bonus or deduction with reason), tips, payout records · API W M
- [ ] 16.8 [new] Suspension with reason, appeal, and a human review decision · API W M

### 17. Dispatch & last-mile
- [ ] 17.1 [new] Live dispatch map: couriers, pickup points, active deliveries (web map; mobile list + map) · API W M
- [ ] 17.2 [improve] Auto-assignment scoring by readiness, proximity, capacity and vehicle capability · API
- [ ] 17.3 [improve] Manual assignment to a chosen courier, with an audited reason · API W M
- [ ] 17.4 [new] Batching rules (same pickup, max 2 orders, direction and ready-time window, food-quality cap) · API W
- [ ] 17.5 [improve] Configurable acceptance timeout; escalate after N failed offers · API W
- [ ] 17.6 [improve] Courier arrival at pickup, route progress pings, delivery confirmation timestamps · API W M
- [ ] 17.7 [new] Customer-unreachable, wrong-address and failed-delivery workflows (contact attempts, wait timer, return or dispose) · API W M
- [ ] 17.8 [fix+improve] Proof of delivery: removed from the public tracking endpoint; staff-only access with audit; retention job · API W M
- [ ] 17.9 [new] Third-party provider failover order (own fleet → provider A → B) · API W
- [ ] 17.10 [new] Courier waiting time and delivery cost analysis (per zone, per provider) · API W M

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
