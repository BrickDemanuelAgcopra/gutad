# Gutad Admin Platform: plan

Goal: one central admin entry point (`/admin` on web, **Ops** workspace on mobile) with connected modules for **operations, merchants, kitchens, delivery, finance, support, growth and security**. Kitchen staff, merchants, couriers and finance teams each get their own restricted workspace. The plan covers all 25 areas of the brief. Where a feature already exists, the work improves it rather than rebuilding it.

Tracking:
- [`Pending_Tasks.md`](Pending_Tasks.md): every task not yet done, grouped by section and phase.
- [`Completed_Tasks.md`](Completed_Tasks.md): each finished task with its date, commit, and what shipped on web and on mobile.

When a task ships, it moves from Pending to Completed in the same commit.

Started 2026-11-13. The baseline is commit `7ffa18f` (Plans Phase 4 complete; 30 blueprint capabilities live).

## Where we start (audit summary, 2026-11-13)

The platform already has a strong transactional core:
- double-entry ledger
- idempotent checkout
- kitchen tickets and packing verification
- delivery orchestration with an own fleet
- reservations
- settlement and payouts
- incidents
- plans and billing

The gaps are mostly about **administration and control**:

| Area | State |
|---|---|
| Admin console | 6 static pages. Every staff role sees every page. Only 4 platform roles exist (`PLATFORM_ADMIN`, `SUPPORT`, `FINANCE`, `DISPATCHER`). Platform staff bypass every org/location check. |
| Mobile | No admin, ops or finance workspace at all. Merchant, kitchen and driver screens are not gated by member role. |
| Approvals | `approvalLimitCents` is stored but **never enforced** (dead code in `SupportService.resolve`). Bank-account changes need one person. There is no emergency access. Audit has no "why". |
| Dashboards | GMV, revenue and contribution only. No AOV. No split between food sales, platform revenue and merchant payable. No region/brand/merchant breakdown. No live ops board, no alerts, no drill-down. |
| Order admin | No platform-wide order search. No order notes. No stuck-order detection beyond unacknowledged orders. |
| Customers | No admin customer view. No account status or restrictions. A customer strike has no effect. |
| Catalog | No draft/publish/rollback, bundles, nutrition, or tax categories. Recipes are global, API-only, and have no allergens. |
| Supply | No suppliers, lots, expiry, transfers, counts, or three-way match. No food-safety records. No equipment, staff schedules, or training. |
| Delivery | Zones are pasted GeoJSON. No live map, courier metrics, batching, or provider failover. **The public tracking endpoint exposes the proof-of-delivery photo.** |
| Finance | No payout approvals or batches. No adjustments, bank-change verification, chart-of-accounts mapping, or gift cards. No deferred subscription revenue, close checklist, or audit export. |
| Growth | No automatic offers, stacking rules, item or segment eligibility, gift cards, or challenges. Referrals pay out instantly with no first-order rule. |

## Architecture decisions

1. **Admin console = module registry.** A shared `ADMIN_MODULES` list (in `packages/shared`) sets each module's key, label, group, the permissions it needs, and its web route and mobile screen.
   - Groups: Overview · Operations · Merchants · Kitchens · Delivery · Finance · Support · Growth · Security.
   - Web `/admin` and the mobile Ops workspace both build their navigation from this list, so the two stay in step.
2. **Permissions, not just roles.**
   - New platform roles: `EXECUTIVE`, `OPERATIONS`, `CULINARY`, `MARKETING`, `IT`. These join `PLATFORM_ADMIN`, `SUPPORT`, `FINANCE` and `DISPATCHER`.
   - Each role maps to permissions such as `ops.read`, `orders.manage`, `finance.payouts.approve` or `customers.pii`. The map lives in shared code.
   - New `staff_scopes` table restricts a staff user to regions, organizations or locations, and to a data-sensitivity ceiling (`PUBLIC` < `INTERNAL` < `CONFIDENTIAL` < `RESTRICTED`).
   - `isPlatformStaff` stops being a blanket bypass. Routes check `can(user, permission, scope)`.
3. **Restricted workspaces.**

   | Who | Web | Mobile |
   |---|---|---|
   | Merchant | `/merchant` | merchant tablet |
   | Kitchen staff | `/merchant/kitchen` (KDS, packing) | kitchen |
   | Courier | `/driver` | driver |
   | Finance team | `/admin` with finance modules only | Ops → Finance |
   | Executives / ops / support / marketing / culinary / IT | `/admin`, filtered by their permissions | Ops, filtered |

   Merchant navigation is filtered by member role. Kitchen and packer roles see only kitchen screens.
4. **One approval engine.** New `approval_requests` table: kind, subject, amount, payload, requester, status, approvers, reason, expiry. Thresholds come from settings, for example `approvals.refund_cents`, `approvals.price_change_bps`, `approvals.payout_cents` and `approvals.po_cents`.
   - Two-person approval (requester ≠ approver) is required for bank-account changes, payout release, fee/beneficiary settings and large refunds.
   - The action runs only on final approval and is idempotent.
5. **Alerts as first-class records.** New `ops_alerts` table: type, severity, subject, owner, escalation deadline, status, and a history of who did what. Worker detectors raise alerts for:
   - stuck orders
   - offline devices
   - stockouts
   - late deliveries
   - failed payouts or webhooks
   - SLA breaches
   - temperature excursions
   - expiring documents
   - equipment faults
5. **Drill-down everywhere.** Every metric endpoint accepts the same filter object (`from`, `to`, `region`, `orgId`, `locationId`, `brandId`, `channel`). Each metric links to `/admin/orders?…` or `/admin/finance/ledger?…` with that filter.
6. **Gutad mixing rule (explicit).** A cart can combine menus only when every menu belongs to the same **Made at Gutad** (`platformOperated`) fulfillment location and that location's kitchen is authorized for each brand. An independent restaurant is always its own order.
   - The rule lives in shared `cartCompatibility()` and is enforced in the quote service, with error code `SEPARATE_ORDER_REQUIRED`.
   - Web and mobile carts use it to explain the split instead of silently clearing the cart.
7. **Mobile coverage rule.** Every module has a mobile surface for monitoring and decisions: dashboards, queues, alerts, approvals, lookups and the key one-tap actions (pause, 86, approve, reassign, resolve).
   - Bulk authoring stays on web: menu import, zone drawing, chart-of-accounts mapping, recipe editing. The mobile screen shows that data read-only and links to the web editor.
   - Pending_Tasks marks each item `W` (web), `M` (mobile) or `W M`.
8. **Safety boundary.** Automated-kitchen and equipment controls only *record* software versions, faults and maintenance, and escalate to an operator. The admin never sends actuation commands that could bypass equipment safety systems.
9. **Conventions kept.**
   - Drizzle schema plus `drizzle-kit generate` migrations (`apps/api/drizzle/0006_…`).
   - Zod DTOs, `AuditService.log` (now with a `reason`), and `LedgerService.post` for any money movement.
   - Worker jobs use `JobsService.locked`.
   - Smoke checks go in `scripts/smoke.mjs`.
   - Seed data stays idempotent.

## Phases

Each phase ships with: migration, API, web, mobile, smoke checks, an updated `docs/CAPABILITY-MAP.md`, and tasks moved to Completed.

| Phase | Theme | Sections |
|---|---|---|
| **A** | Console foundation & security: module registry, roles/permissions/scopes, approvals engine, emergency access, sessions/MFA/SSO, audit reason, support access, mobile Ops shell, workspace gating | 2, 5.8, workspaces |
| **B** | Executive dashboard, live operations, alerts, drill-down, central order management | 1, 12 |
| **C** | Locations, merchant onboarding & lifecycle, merchant administration, brand ownership | 3, 4, 5, 6 |
| **D** | Menu catalog, recipes, pricing/fees/tax | 7, 8, 9 |
| **E** | Customers, cart & checkout eligibility (Gutad mixing rule), support & service recovery | 10, 11, 24 |
| **F** | Kitchen display, packing/handoff/pickup/dine-in | 13, 14 |
| **G** | Delivery zones & promises, couriers, dispatch | 15, 16, 17 |
| **H** | Payments ops, settlement/royalties/payouts, accounting & treasury | 18, 19, 20 |
| **I** | Inventory & procurement, food safety & recalls, workforce/training/equipment | 21, 22, 23 |
| **J** | Promotions, rewards, referrals, memberships, gift cards, campaign measurement | 25 |

Order rationale: Phase A comes first because every later module depends on permissions, approvals and the console shell. Phase B gives immediate operational value. The remaining phases follow the order's lifecycle (merchant → menu → checkout → kitchen → delivery → money → supply → growth).

## Integrations: honest scope

- **SSO**: OIDC (authorization-code) login for staff, set up through settings. Without an identity provider configured it is off, and staff use password plus MFA.
- **MFA**: TOTP (RFC 6238), implemented in-house with no new dependency.
- **Tax provider**: a `TaxProvider` interface. The `flat` provider is the default and uses today's behavior with item tax categories. Avalara or TaxJar adapters fit behind it, but no account is configured.
- **Accounting system**: chart-of-accounts mapping plus a journal export (CSV/JSON in a QuickBooks/Xero-compatible layout). A live push needs credentials that we don't have.
- **Payroll and attendance**: a CSV export of shifts and time entries.
- **Weather and disruptions**: manual restrictions plus a webhook intake. No vendor is chosen.

These capabilities are proposed. They make no claim about which accounting or tax software Gutad actually uses.

## Verification

Each phase must pass all of the following before it counts as done:
- `npm run typecheck`, which covers shared, api, web and mobile.
- `npm run build:api`.
- `npm run smoke` against a local stack.
- A manual check of the new web pages.

Deploying to gutad.io is a separate step and needs the owner's go-ahead each time.
