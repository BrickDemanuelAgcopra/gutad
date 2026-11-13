# Plans & billing: work tracker

Goal: replace the hardcoded `PLAN_CATALOG` with plans, prices, fees and features that are fully configurable from the admin panel, enforced in the API and apps, and self-serve for merchants on web and mobile.

Started 2026-11-13. Update this file as each item lands (`[x]` done, `[~]` in progress, `[ ]` not started). Record what shipped and when in the log at the bottom.

## Decisions (agreed 2026-11-13)

- **Plans are split by product line:** Ordering (Direct, Direct Pro, Marketplace Plus), Reservations (Core, Pro) and Suite (Full suite). Reservations-only plans show no marketplace commission.
- **Pickup has its own commission:** new plan versions charge 6% on marketplace pickup (DoorDash's rate) and the plan's full rate on marketplace delivery. Existing signed contracts keep their current terms until they move to a new version.
- **Merchants self-serve plan changes** (Phase 3). Admin approval is needed only for per-merchant overrides.
- **Mobile can't take payments for plans:** upgrades open the web billing page.

## Phase 1: data model, admin, public pricing

- [x] Tables: `features`, `plans`, `plan_versions`, `plan_fees`, `plan_features`
- [x] Contracts store their fee rules (`merchant_contracts.fees`) and link to `plan_version_id`
- [x] Existing contracts keep their terms: rules are derived from their flat columns at read time (`legacyFeeRules`), so no data backfill is needed
- [x] Seed the default feature list and today's six plans as published v1 (skipped if plans already exist)
- [x] `termsFor` resolves fees by channel **and fulfillment** (most specific rule wins); quotes, reservations and events pass the fulfillment type
- [x] Creating a contract copies the plan's current published version (fees, features, price); overrides still work (`overrides.fees` replaces the rules)
- [x] Admin API: list, create and edit plans; create, edit and publish versions; archive; manage features
- [x] Optional second-admin approval to publish a version (platform setting `approvals.plan_publish`)
- [x] Admin UI: Admin → Plans & pricing (plan list by product line, version editor with fee rows and features, cost preview, publish, Features tab)
- [x] Admin UI: contract assignment picks from published plans (grouped by product line) and shows the fees that will be signed
- [x] Public API `/public/plans` returns product lines, current version, fees and features
- [x] Public `/pricing` page with tabs and a comparison table; For restaurants page uses the new data; footer link
- [x] Fix: "NaN% marketplace" and "$0.00/network cover" on plan cards
- [x] Order Form views (onboarding, merchant finance) list fee rules in plain words
- [x] Smoke tests for fee resolution, plan versioning and the admin API (17 new checks)
- [x] Deploy to gutad.io and verify (catalog seeded in production; /pricing, /admin/plans, /for-restaurants live)

## Phase 2: enforcement

- [ ] `EntitlementsService.can(locationId, feature)` merging plan features, add-ons and overrides
- [ ] `@RequiresFeature()` API guard on reservations, waitlist, floor plan, events, experiences, shared kitchen, group orders, meal kits, ads, branded site
- [ ] Location and team-member limits checked on create
- [ ] Customer pages hide services the plan doesn't include
- [ ] Merchant navigation shows locked features with an upgrade prompt
- [ ] `/me/entitlements` endpoint for web and mobile
- [ ] Remove or migrate the unused organization feature flags
- [ ] Marketplace visibility boost for plans with `marketplace_boost`
- [ ] Smoke tests: features not in the plan return 403; limits enforced

## Phase 3: merchant self-serve

- [ ] Merchant Plan & billing page: current plan, usage this month, next invoice, invoice history
- [ ] Compare and switch plans: upgrades now (prorated), downgrades at renewal with a warning about lost features
- [ ] Switching issues a new Order Form for signature (reuse onboarding signing)
- [ ] Admin: move subscribers to a new plan version on a chosen date
- [ ] Subscription lifecycle: trial, active, past due, paused, canceled
- [ ] Add-ons (`add_ons` table, admin CRUD, merchant purchase/cancel)
- [ ] Smoke tests for upgrade, downgrade at renewal and proration

## Known issues found along the way

- [ ] Smoke check "waitlist → walk-in seated" fails between the demo shifts (15:00–17:00 and after 22:30 New York time) because it seats a walk-in "now". Make the test pick a time inside a shift. Not caused by plan work.

## Phase 4: mobile, promotions, reporting

- [ ] Mobile: plan summary and usage on the merchant dashboard
- [ ] Mobile: locked features show an upgrade prompt that opens web billing
- [ ] Promotions and trials (`promotions` table, codes, free months, commission holiday)
- [ ] Admin revenue view: MRR by plan, trial conversion, upgrades/downgrades, cover and commission revenue
- [ ] Update `docs/CAPABILITY-MAP.md`

## Log

- 2026-11-13: tracker created; Phase 1 started.
- 2026-11-13: Phase 1 shipped (commits 9ded42c, 81d4e75). 111 smoke checks; 110 pass, the 1 failure is the time-of-day waitlist issue listed above. Production DB backup before deploy: deploy/backups/gutad-predeploy-20261113-214147.dump. Next: Phase 2 (enforcement).
