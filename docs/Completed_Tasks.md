# Completed tasks: Gutad Admin Platform

The plan is in [`ADMIN-PLATFORM-PLAN.md`](ADMIN-PLATFORM-PLAN.md). Open work is in [`Pending_Tasks.md`](Pending_Tasks.md).

Each entry records the task id from Pending_Tasks, the date, the commit, and what shipped on each surface: **API**, **Web (W)** and **Mobile (M)**. Mobile is marked "n/a, web editor" only where the plan's mobile coverage rule allows it.

## Planning

- **P.0** Audit of all 25 areas against the codebase. Plan written, Pending/Completed trackers created. 2026-11-13.

## Phase A: console foundation & security (shipped 2026-11-13, not yet committed)

Verification:
- `npm run typecheck`: shared, API, web and mobile all clean.
- `next build`: OK.
- `npm run smoke` on a freshly migrated and seeded database: **191/191 checks pass**, including 39 new Phase A checks in `scripts/smoke-admin-a.mjs`.
- Migration `apps/api/drizzle/0006_admin_security.sql`.

### 0. Central entry point & workspaces
- **0.1** Module registry. `ADMIN_MODULES`, `ROLE_PERMISSIONS`, `PERMISSIONS` (with data sensitivity) and `APPROVAL_KINDS` live in `packages/shared/src/admin.ts`, used by API, web and mobile.
- **0.2** `/admin` is the control center: navigation grouped Overview · Operations · Merchants · Kitchens · Delivery · Finance · Support · Growth · Security, built from the registry and filtered by the user's permissions. It shows a pending-approvals badge and banners for emergency access, support access and required MFA. **W**
- **0.3** Mobile **Ops** workspace (`app/ops/index`): module tiles from the same registry, filtered by permission, plus the access banner. It opens from Account for staff. **M**
- **0.4** Restricted workspaces:
  - Web merchant nav is filtered by member role through `merchantPageAllowed`. Kitchen and packer staff see Kitchen and Orders; hosts see the host stand; dispatchers see delivery. Pages outside the role show a notice. **W**
  - Mobile merchant tablet, host and kitchen screens are wrapped in `WorkspaceGate`. **M**
  - Finance staff see only finance modules, because the console navigation follows permissions.
- **0.5** Mobile Account shows only the workspaces the person can open: Ops for staff, and only the merchant screens their role uses. **M**

### 2. Organization structure & administrative access
- **2.1** Hierarchy:
  - `regions` table (nestable), `locations.region_id` and `organizations.parent_id`.
  - `GET /admin/structure` returns a tree: companies → legal entities → regions → food halls (kitchen + brands) and independent merchants → locations.
  - Endpoints to add regions, assign a location's region, and set a parent company.
  - **W** `/admin/structure` (add region, move locations). **M** `ops/structure` (read-only).
- **2.2** New roles EXECUTIVE, OPERATIONS, CULINARY, MARKETING and IT, plus the existing PLATFORM_ADMIN, SUPPORT, FINANCE and DISPATCHER. Each maps to its own permission set in shared code. Staff roles can be granted only through the Security module, and only a platform admin can grant platform admin. **API W M**
- **2.3** Scoping:
  - `staff_scopes` limits a person to regions, organizations or locations (regions are expanded into the token at sign-in) and sets a sensitivity ceiling.
  - `assertOrgAccess` now checks the staff scope instead of letting staff bypass it, and `can()` / `@RequiresPermission` replace "platform admin only" checks in AdminService.
  - Admin tenant and organization lists and order reads are filtered by scope. **API W**
- **2.4a** Sessions:
  - `user_sessions` table; access tokens carry `sid`.
  - Revoking a session kills its refresh tokens, and its access tokens are rejected through Redis.
  - Users can list their devices, sign one out, or sign out all others.
  - Staff tokens get their own lifetime, idle timeout and maximum session length (setting `security.sessions`).
  - **W** Account → Security, Staff detail. **M** `security` screen, `ops/security`.
- **2.4b** MFA:
  - TOTP (RFC 6238, built in, no new dependency) with 8 one-time recovery codes, plus an MFA challenge step at sign-in on web and mobile.
  - `security.mfa_required_roles` locks the console (no permissions) until the person enrolls.
  - Admins can reset someone's MFA, with a reason. **API W M**
- **2.4c** SSO with OpenID Connect (authorization code, RS256 id-token verified against the provider's JWKS, nonce and state checks):
  - Configured under Staff & access → Security policy; the client secret is encrypted.
  - Only existing accounts can sign in through SSO, optionally limited to allowed email domains.
  - **W** "Sign in with SSO" button and `/account/sso` callback. Mobile SSO is still pending (2.4c-M).
- **2.4d** Access revocation: disabling a staff user ends every session, revokes their grants and blocks sign-in, all in one step with a reason. Role or scope changes end the person's sessions so the new claims apply. **API W M**
- **2.5** Approval thresholds:
  - New `approval_requests` engine with handlers registered by each module, dedupe keys, expiry (worker job) and retry on failure.
  - Thresholds come from `approvals.thresholds`: refund limits per staff role, price-change %, purchase-order amount and payout amount.
  - **Fixed** the unenforced `approvalLimitCents` in `SupportService.resolve`. Merchant staff are now limited by their membership limit (owners unlimited); staff by their role limit.
  - Purchase orders above the threshold wait in `PENDING_APPROVAL` and cannot be received until approved. Price changes above the threshold need approval when the setting is on.
  - **W** `/admin/approvals` and the shared `ApprovalsTable`. **M** `ops/approvals`.
- **2.6** Two-person approval:
  - The requester can never approve their own request.
  - Bank and beneficiary changes (`POST /legal-sellers/:id/bank-change`, edits to the seller's name or tax id, and reconnecting a payout account) need `finance.approve` from someone else. The merchant cannot approve them.
  - Fee, payout, beneficiary and approval settings need a second person with `settings.manage`. This replaces the old "type a second admin's email" field, which never asked that admin.
  - Payout release follows with 19.4 (2.6-P).
- **2.7** Emergency (break-glass) access:
  - Time-limited elevation to extra staff roles with a mandatory reason (at least 10 characters) and an optional ticket reference. Max duration and grantable roles come from `security.emergency`; platform admin is not grantable by default.
  - Every platform admin gets an email, push and in-app alert. Actions taken under the grant are tagged with its id and counted.
  - The grant can be ended early. Afterwards someone other than the holder reviews it.
  - **W** Staff & access → My emergency access / Emergency & support access. **M** `ops/security` → Break-glass / Access grants.
- **2.8** Audit:
  - `audit_logs` gains `reason`, `request_id` and `grant_id`. The reason comes from the request (body `reason` or header `X-Audit-Reason`), and `@RequiresReason()` enforces it on sensitive routes.
  - Added audit entries for brand create/update, location pause/resume, menu item edits and price changes, purchase orders, approvals, staff changes and grants.
  - Search by person, action, entity and dates; CSV export (the export is itself audited).
  - **W** `/admin/audit` (detail view with before/after, configuration history). **M** `ops/audit`.

### 5. Merchant portal administration
- **5.8** Audited support access ("view as merchant"):
  - A time-limited session for one organization with a required reason; read-only by default, and allowing changes needs `merchants.manage`. A read-only session blocks every change (`SUPPORT_READ_ONLY`).
  - Staff can open the web merchant portal only through a support session (a "View as merchant" button on admin tenants opens it). Merchant passwords are never exposed.
  - **W** Merchant portal support gate and banner. **M** The access banner shows and ends an active session. Starting one happens on web, because the mobile tablet is a merchant-staff workspace.

### Cross-cutting
- **X.3 (Phase A)** Typecheck is clean for shared, API, web and mobile.
- Plan, Pending and Completed trackers created in `docs/`.

## Phase B: executive dashboard, live operations, central orders (shipped 2026-11-13, not yet committed)

Verification:
- Typecheck is clean for API, web and mobile.
- `next build`: OK.
- `npm run smoke` on a fresh database: **219/219 checks pass**, including 28 new Phase B checks in `scripts/smoke-admin-b.mjs`.
- Migration `0007_ops_alerts_notes.sql` adds `ops_alerts`, `order_notes`, `message_templates` and `orders.partial_fulfillment`.
- API module `modules/ops` (`OpsService`, `AlertsService`); worker jobs run detectors and escalation every minute.

### 1. Executive dashboard & live operations
- **1.1** Orders, gross sales, refunds (amount and count), cancellations and rejections (with rate), and AOV, each compared with the previous period of the same length, plus a daily gross-sales trend.
  - **W** `/admin` is now the executive dashboard: KPI tiles, a trend chart and a filter row (Today / 7d / 30d / 90d, region, merchant, location, brand, channel).
  - **M** `ops/executive`.
- **1.2** Separate figures for gross food sales, platform revenue (from the ledger, broken down by revenue stream) and merchant amounts payable (ledger `MERCHANT_PAYABLE`), plus platform expenses. **W M**
- **1.3** Performance by region, location, merchant, brand (from order lines) and ordering channel, as bars plus a table; every row drills down. **W M**
- **1.4** Platform-wide live board, scoped to the viewer: awaiting acceptance, cooking, ready for pickup, awaiting courier, out for delivery, and overdue (minutes past promise). Refreshes every 10 s. **W** `/admin/live`. **M** `ops/live`.
- **1.5** Capacity:
  - Kitchen load per location: last 15 minutes against the throttle, as a percentage, and orders cooking.
  - Couriers available, approved and busy; jobs waiting for a courier.
  - Items sold out per location, paused locations, offline devices.
  - One-tap pause/resume with a reason.
  - **W M**
- **1.6** Contribution margin per order: revenue minus food (recipe ingredient cost), labor (recipe minutes × `ops.labor_rate_cents_per_hour`, default $18/h), delivery (provider cost plus driver base pay), processing and promotions.
  - Shows the average, margin %, the number of orders below zero, the lowest-margin orders, and the platform's own ledger contribution per order.
  - Follow-up for actual labor hours: 1.6-L. **W M**
- **1.7** Alerts (`ops_alerts`):
  - Each alert has a type, severity, owning team or person, an escalation deadline per severity, and a full history (raised, acknowledged, assigned, comment, escalated, resolved, auto-resolved, reopened).
  - Detectors run every minute and look for: unaccepted orders, overdue orders, ready orders waiting, late deliveries, status conflicts, duplicate events, offline devices, locations paused with no reopening time, failed or held payouts, and failed webhooks. Duplicates are suppressed while an alert is open, and an alert auto-resolves when its condition clears.
  - Escalation moves ownership up a level (e.g. operations → executive → platform admin) and pages the new owner. HIGH and CRITICAL alerts page the owning team.
  - Acting on an alert needs the owning team's manage permission; anyone who can see it can comment. People can also raise alerts manually.
  - **W** `/admin/alerts`. **M** `ops/alerts`.
- **1.8** Drill-down: every KPI tile, live bucket and performance row links to `/admin/orders` with the same filter (bucket, overdue, refunded, canceled, location, merchant, brand, region, channel, dates). **W M**

### 12. Central order management
- **12.1** `/admin/orders` search, scoped to the viewer:
  - by order number, order id, payment intent/charge id, delivery provider job id, POS ticket or external id
  - by customer name, email or phone
  - by location, merchant, region, brand, channel, courier, status and dates
  - Paginated. Customer contact is masked for roles without `customers.pii`.
  - **W M**
- **12.2** The order detail shows one timeline that merges order events, kitchen tickets, delivery events, refunds and notes, plus the notifications sent. **W** `/admin/orders/[id]`. **M** `ops/order/[id]`.
- **12.3** The detail page shows the customer order, payment (with refunds and dispute state), kitchen tickets, and the delivery job (proof link for staff) as separate panels. **W M**
- **12.4** Staff actions from the order page:
  - accept for the merchant, mark ready, confirm handoff
  - cancel with a reason and a cost owner (audited)
  - **W M**
- **12.5** Routing: tickets per station are shown; `POST /admin/orders/:id/reroute` moves open tickets to another station, logging an order event and an audit entry. **W**
- **12.6** Partial fulfillment: crediting an unavailable line sets `orders.partial_fulfillment`. It shows as a badge and is filterable (`partial=true`). Scheduled and rejected orders are filterable too. **API W M**
- **12.7** Controlled remedy from the order page: refund, credit, remake or redelivery opens a ticket and resolves it through the support flow, so approval limits and the repeat-compensation check apply. **W M**
- **12.8** Stuck orders, duplicate events and conflicting statuses, checked both per order (`issues` on the detail page) and platform-wide (detectors → alerts). The conflicts covered:
  - delivered but the order is not completed
  - completed but the delivery is not finished
  - canceled with captured money not refunded
  - completed but the payment was only authorized
  - canceled with a courier still assigned
  - **API W M**
- **12.9** Order notes (internal, or customer-visible, which sends the `order.message` notification) and approved response templates (`message_templates`, six seeded; `{{number}}` and `{{name}}` are filled in; editable via `POST /admin/message-templates`). The detail page lists the messages sent. **W M**

## Phase C: locations, merchants, brands (shipped 2026-11-13)

Verification:
- Typecheck is clean for API, web and mobile.
- `next build`: OK.
- `npm run smoke` on a fresh database: **250/250 checks pass**, including 31 new Phase C checks in `scripts/smoke-admin-c.mjs`.
- Migration `0008_merchant_admin.sql`:
  - new tables `location_closures`, `location_launch_items`, `merchant_applications`, `change_requests`, `brand_reviews`, `incident_messages`
  - new columns on locations, organizations, brands, stations, merchant documents and incidents
  - `KIOSK` added to the channel enum
- API module `modules/merchant-admin`: `LocationsAdminService`, `MerchantsAdminService`, `BrandsAdminService`.
- New worker jobs: restart ramps, document expiry, brand rights expiry.

### 3. Food hall & location management
- **3.1** Named contacts (`locations.contacts`) alongside address, coordinates, timezone and status. The admin location page shows everything; merchants and staff edit through `PATCH /locations/:id`. **W M**
- **3.2** `location_closures`: holiday closures, special hours and temporary closures with a reopening time, for ordering, reservations or both.
  - Quotes refuse orders while closed and use special hours instead of regular hours.
  - The public page shows upcoming closures, and "open now" respects them.
  - Quick "close ordering for 1/2/4 h" buttons.
  - **W** admin location page and merchant Location & launch. **M** merchant `location` screen and `ops/locations`.
- **3.3** Channel availability flags: pickup, delivery, dine-in and the new **kiosk** flag (`KIOSK` channel added). **W M**
- **3.4** Brands and menus offered at each location: menus with brand, channels, daypart, item and sold-out counts; brands with ownership, kitchen authorization and stop-sell reason. **W M**
- **3.5** Stations get a ticket capacity (`max_concurrent`), equipment and an available/down state (`POST /kitchens/:id/stations`). The location's maximum throughput is the existing throttle. **W**
- **3.6** Launch checklist with 14 items:
  - Ten are computed automatically: agreement, Order Form, documents, payouts, verified, menu, hours, pickup info, team, test order.
  - The rest are signed off by a person: training (by the merchant), equipment, photos and signage (by Gutad).
  - Readiness approval (`POST /admin/locations/:id/readiness`) needs every required item done.
  - A location cannot go LIVE for the first time until readiness is approved (setting `launch.require_readiness`, default on).
  - **W M**
- **3.7** Pickup instructions, parking details and courier collection point (instructions plus coordinates), shown on the public restaurant page. **W M**
- **3.8** Emergency pause of selected locations or a whole region, with a required reason. It raises a CRITICAL alert, and only Gutad can restart afterwards.
  - Controlled restart reopens with a temporary throttle (default: a third of the normal one) for a ramp period; a worker clears finished ramps.
  - **W** `/admin/locations`, location page. **M** `ops/locations`, merchant `location`.

### 4. Merchant onboarding & lifecycle
- **4.1** `merchant_applications` pipeline: LEAD → CONTACTED → APPLIED → APPROVED → ONBOARDING → LIVE, or LOST (which needs a reason). It keeps a history and an owner.
  - Public application form on For restaurants (`POST /public/merchant-applications`, deduplicated). Leads can also be added manually.
  - "Approve & create merchant" provisions the tenant and invites the owner.
  - **W** `/admin/pipeline`. **M** `ops/merchants`.
- **4.2** Business identity: beneficial owners (validated to total at most 100%), contacts, website and tax id (`PATCH /organizations/:id/profile`). Payout details stay on the legal seller, and changing them still goes through two-person approval. **W** merchant Location & launch, admin merchant page.
- **4.3** Document expiry:
  - The reviewer sets an expiry date when approving (prompted in the admin document queue).
  - A job marks expired documents EXPIRED and reminds owners once, 30 days before.
  - Expired documents count as outstanding requirements.
  - **API W** (test follow-up 4.3-T).
- **4.4** Contract versions, plan, signature and effective dates, plus Merchant Agreement acceptance records (signer, title, time, IP), on the admin merchant page. **W**
- **4.5** Participating locations and merchant admins: the team list with invite and remove on the admin merchant page (location-picker follow-up 5.1-L). **W**
- **4.6** Menu import, operational setup, training and test-order items are part of the launch checklist (3.6). A test order is detected automatically from a completed order, or Gutad can sign it off manually. **W M**
- **4.7** Lifecycle (`POST /admin/organizations/:id/lifecycle`), each with a reason and kept in history:
  - Approve, activate.
  - Suspend: saves each location's state and stops all of them.
  - Reinstate: restores those states.
  - Terminate: runs offboarding with commitment checks.
  - **W M**
- **4.8** Onboarding progress percentage per merchant, from the checklists, plus the outstanding requirements and account-manager assignment. **W** `/admin/pipeline` → Onboarding, merchant page. **M** `ops/merchants`.

### 5. Merchant portal administration
- **5.1** Gutad creates merchant accounts (pipeline convert or tenant provisioning) and invites admins and staff from the merchant page. **W**
- **5.2** `change_requests`: when `merchants.review_changes` is on, merchant edits to menu items (name, description, photo, allergens, dietary tags, price) and business information wait for review.
  - Approving applies the change through the normal path, so it is audited and the cache is cleared. Rejection needs a note. The merchant is notified either way.
  - **W** `/admin/changes`. **M** `ops/merchants` → Changes.
- **5.3** Order acceptance settings: auto-accept for immediate orders, and a per-location acceptance timeout (auto-reject at 4×) used by the escalation job, plus default prep time. **W M**
- **5.4** Admin view of temporarily unavailable items, paused stores and stations down across merchants, with one-tap fixes. **W** `/admin/availability`. **M** `ops/locations` → Availability.
- **5.5** Order-by-order statement lines: sales, tax + tip, merchant-funded discounts, commission, processing, merchant-funded refunds and net from the ledger, with totals and CSV export. **W** merchant Finance.
- **5.6** Merchant support cases:
  - Merchants open cases and see complaints and disputes about their orders.
  - Each case has a conversation (`incident_messages`). Staff can reply to the parties or leave internal notes using templates.
  - A merchant reply to a resolved case re-opens it as an appeal.
  - **W** merchant Support, admin Support thread. **M** merchant `support`.
- **5.7** Merchant performance per location: acceptance rate, timeouts, time to accept, cancellation and rejection rate, average prep, lateness and error rate, with red flags. **W** `/admin/performance`. **M** `ops/merchants` → Performance.

### 6. Brand ownership & culinary partnerships
- **6.1** Ownership type: company-owned, licensed, independent or creator, plus owner/licensor. **W M**
- **6.2** Operating rights text, territories (regions), contract start and end, and rights status with a note. **W**
- **6.3** Royalty and revenue-share rules: % of sales, per item, or tiered %, optionally per channel, with a minimum guarantee. Falls back to the flat rate. Computed by `computeRoyalty` (settlement follow-up 6.3-S). **W**
- **6.4** Brand → authorized kitchens (authorize or revoke) and authorized channels. Quotes and public menus enforce the channel rule. **W**
- **6.5** Brand asset library (logos and photos with approval) and presentation standards. The brand owner can edit these; rights are Gutad-only. **W**
- **6.6** `brand_reviews`: recipe approvals, quality reviews and mystery shops with a score and PASS / NEEDS_WORK / FAIL, recorded by culinary or catalog staff only. **W**
- **6.7** Partner statement per month: sales by channel and location, top items, royalty with its rule breakdown, and quality summary. **W M**
- **6.8** Stop-sell: a brand stops selling at once when its rights are suspended or expired, its contract has ended, content rights are missing, it is outside its territory, or the channel isn't authorized.
  - Enforced in public menus and quotes (`BRAND_NOT_AVAILABLE`).
  - A job expires contracts and raises an alert.
  - **API W M**
