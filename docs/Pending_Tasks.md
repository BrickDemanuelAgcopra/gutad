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

---

## Phase B: executive dashboard, live ops, central orders

Phase B shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 1.V [verify] Look at the dashboard, live board and order pages in a browser and on a device. Only the build, HTTP checks and smoke have been run so far · W M

---

## Phase C: locations, merchants, brands

Phase C shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 5.1-L [improve] Location picker and approval limit when inviting merchant staff from the admin merchant page; the API accepts them, the admin form does not show them yet · W
- [ ] 4.3-T [verify] Smoke check for document expiry (needs a document upload in the smoke run) · API

---

## Phase D: menu, recipes, pricing

Phase D shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 7.7-M [improve] Include modifier groups and options in versioned menu documents (today versions cover categories and items; modifier groups change directly) · API W
- [ ] 9.5-X [new] External tax provider adapter (Avalara or TaxJar) behind the tax calculation; today the built-in rate table is used · API

---

## Phase E: customers, checkout, support

Phase E shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
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
- [ ] 17.1-R [new] Push-based live map updates (today: polling every 10–15 seconds) · API W M
- [ ] 17.9-M [improve] More than one partner provider at a time: failover between two configured third-party providers (today: own fleet → the configured provider) · API

---

## Phase H: payments, settlement, accounting

Phase H shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 18.9-S [new] Mount the processor's hosted card field / payment sheet (Stripe Elements on web, PaymentSheet on mobile) when the live processor is configured; test mode uses the test-card picker · W M
- [ ] 20.1-L [new] Live push of journals to the general ledger once accounting-software credentials exist (today: CSV export in a general-journal layout) · API
- [ ] 20.7-L [improve] Lock ledger postings dated in a closed month (today: the close is recorded and checked, postings are never back-dated) · API

---

## Phase I: supply, safety, workforce

Phase I shipped on 2026-11-13; see Completed_Tasks. These follow-ups remain:
- [ ] 21.6-S [improve] Seasonality and promotions in the demand forecast (today: weekday moving average over 4 weeks) · API
- [ ] 21.8-P [new] Supplier portal or EDI for invoices (today: staff enter the invoice lines to match) · API W
- [ ] 22.2-S [new] Wireless temperature sensors feeding storage logs automatically (today: manual readings) · API W M
- [ ] 23.3-P [new] Payroll provider integration (today: CSV export of approved hours with overtime) · API W
- [ ] 23.8-V [improve] Equipment vendor integrations for automated kitchens beyond the fault/version feed (still record-and-alert only, no actuation) · API

---

## Phase J: growth

Phase J shipped on 2026-11-14; see Completed_Tasks. These follow-ups remain:
- [ ] 25.1-B [new] Buy-one-get-one and free-item offers (today: percent off, amount off, free delivery) · API W
- [ ] 25.7-P [improve] Switch membership plans mid-period with proration (today: cancel, then join the other plan) · API W M
- [ ] 25.9-M [improve] Buy gift cards in the mobile app (today: buy on the web; the app adds codes and spends the balance) · M
- [ ] 25.9-E [new] Unclaimed-property (escheat) reporting for old gift balances by state · API W
- [ ] 25.10-P [improve] Gutad-wide email/SMS campaigns to platform customer segments with a holdout (today: Gutad-wide campaigns run offers; merchants send messages) · API W
- [ ] 25.10-S [improve] Confidence interval on incremental orders and revenue (today: point estimates, with a note when the holdout is small) · API W

---

## Cross-cutting (every phase)
- [ ] X.1 Migrations, seed data for every new module, smoke checks
- [ ] X.2 `docs/CAPABILITY-MAP.md` updated per phase
- [ ] X.3 Typecheck shared, API, web and mobile clean per phase
