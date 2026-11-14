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

## Phase D: menu, recipes, pricing (shipped 2026-11-13)

Verification:
- Typecheck is clean for API, web and mobile.
- `next build`: OK.
- `npm run smoke` on a fresh database: **275/275 checks pass**, including 25 new Phase D checks in `scripts/smoke-admin-d.mjs`.
- Migration `0009_menu_pricing.sql`:
  - new tables `menu_versions`, `menu_location_links`, `item_location_overrides`, `price_changes`, `tax_rates`, `recipe_acknowledgments`
  - new columns on menu items, recipes, ingredients, coupons, quotes, orders and locations
  - the global unique constraint on ingredient names is dropped, so merchants can have their own ingredients
- New `MenuAdminService` (catalog), `RecipesService` (kitchen), and `PricingModule`.
- Shared `packages/shared/src/pricing.ts`: fee rules, `computeCustomerFees`, tax categories, item kinds, allergens.
- New worker job applies scheduled price changes.

### 7. Menu & product catalog
- **7.1** Serving size and extra photos on items, shown on public menus. **W** item details page.
- **7.2** Modifier groups are reusable: list the groups used across a menu and attach or detach an existing group on any item (`/items/:id/modifier-groups/:groupId`). **W**
- **7.3** Nutrition (calories, macros, sodium, sugar) on items. Ingredients carry allergens; an item shows the allergens from its recipe and from its modifier options, and highlights any it doesn't list. **W M** (kitchen recipe cards show allergens)
- **7.4** Location-specific assortment and pricing:
  - A menu can be offered at other locations of the same merchant (`menu_location_links`).
  - Per-location price, hidden or sold-out overrides (`item_location_overrides`), applied on public menus and at checkout.
  - **W**
- **7.5 (fix)** The menu daypart and days now apply at checkout too: `resolveItems` used to ignore them. **API**
- **7.6** Item kinds: item, bundle, beverage, extra, packaging. Bundles and combos use required modifier groups for their components. Packaging is also a fee rule (9.2). **W**
- **7.7** Draft → review → publish → rollback:
  - `menu_versions` holds documents.
  - Drafts are edited separately while customers keep seeing the live menu. Drafts are validated and diffed against live.
  - Publishing applies changes by item id and switches off removed items rather than deleting them, so past orders keep their references. The live menu before the first versioned publish is kept as a baseline.
  - Rollback republishes an older version as a new one.
  - With `menus.require_review`, someone other than the author publishes.
  - **W** merchant Menu → Versions & publish, admin Menus & recipes review. **M** `ops/culinary` (publish or send back).
- **7.8** Export as CSV or JSON. Import validation (dry run) reports errors, duplicate names and items already on the menu. **W**

### 8. Recipe & culinary production
- **8.1** Recipes belong to a merchant (`organization_id`), with quantities, yield and portion size. Merchants keep their own ingredients; the shared catalog is maintained by Gutad culinary only.
  - **Fixed:** previously any merchant role could overwrite shared ingredient costs.
  - **W** merchant Recipes. **M** merchant `recipes`.
- **8.2** Preparation steps with a station code and minutes per step, shown on kitchen recipe cards. **W M**
- **8.3** Versions: a new version is a draft copied from the current one, with a change summary and full history. Approved ingredient substitutions show the substitute's allergens. **W**
- **8.4** Plate cost (ingredients plus labor at the configurable rate) and, for each menu item using the recipe, food cost % and margin. **W M**
- **8.5** Equipment requirements, prep minutes and maximum batch size are recorded (enforcement in kitchen batching: follow-up 8.5-K). **W**
- **8.6** Test-kitchen trials (notes and score). Release needs approval by someone other than the author: the merchant owner/manager or Gutad culinary. Setting `recipes.require_trial` can require a trial first. Approved recipes cannot be edited; you start a new version instead. **W M**
- **8.7** Training notes and link per recipe. Kitchen staff are notified of a new version and confirm they've read it; the recipe page lists who has and hasn't. **W M**
- **8.8** Traceability: releasing a recipe flags every menu item whose listed allergens miss one in the recipe (`allergen_review_needed`). Changing an ingredient's allergens flags every item that uses it. Flags appear for the merchant (Recipes, item details) and for Gutad culinary (allergen review). **API W M**

### 9. Pricing, fees & tax
- **9.1** Base price plus per-channel prices plus per-location overrides (7.4). Price changes above the threshold go through approval (Phase A). **W**
- **9.2** Configurable customer fees (setting `fees.customer`):
  - service fee: % with min and cap, by channel and fulfillment
  - small-order fee
  - packaging fee: per order and per item, or a location's own amount
  - These replace the hard-coded service-fee constants; the defaults keep today's behavior.
  - New `small_order_fee_cents` and `packaging_fee_cents` on quotes and orders. In the ledger, packaging goes to the merchant payable and the small-order fee to platform revenue.
  - **W** admin Pricing → Customer fees.
- **9.3** Membership benefits (free delivery threshold, service fee waiver, monthly credit, priority waitlist) are editable in admin. **W M** (read)
- **9.4** Commission (published plan fees), brand royalties, promotion funding and scheduled price changes on one page. **W M**
- **9.5** Item tax categories (standard, prepared food, beverage, alcohol, grocery, merchandise, exempt):
  - `tax_rates` resolves location, then region, then platform, then the location's own rate.
  - Discounts are spread across categories. With a single category the result is identical to the old flat calculation.
  - Tax lines are frozen into the quote snapshot.
  - External tax provider: follow-up 9.5-X.
  - **W**
- **9.6** Promotion funding split: a coupon can be funded part platform, part merchant (`platform_share_pct`, staff only). The ledger re-credits the merchant only for the platform's share. **W**
- **9.7** Effective-dated price changes (now or on a date; base, channel or location price), approval when above the threshold, cancellation, a worker that applies them when due, and price history from the audit trail. **W**
- **9.8** Checkout-price simulator: `QuoteService.simulate` prices a sample cart with draft fee rules, tax rates and item prices without storing anything, and compares it with today. **W** admin Pricing → Simulator.

### 11. Cart & checkout (done along the way)
- **11.2** Per-item quantity limit (`max_per_order`, `QUANTITY_LIMIT`). **API W M**

## Phase E: customers, checkout, support (shipped 2026-11-13)

Verification:
- Typecheck is clean for API, web and mobile; `next build`: OK.
- `npm run smoke` on a fresh database: **296/296 checks pass**, including 21 new Phase E checks in `scripts/smoke-admin-e.mjs`.
- Migration `0010_customers_support.sql`:
  - new tables `payment_methods` (processor token, brand, last 4 only), `customer_restrictions`, `platform_segments`
  - new columns on users (notification preferences, processor customer reference, merged-into), incidents (priority, queue, SLA due/breach, first response, menu item, responsibility dispute), data requests (scheduled date, reviewer, note) and locations (scheduled slot capacity, schedule lead minutes)
- New `CustomersModule`; shared `packages/shared/src/support.ts` (categories with owner/priority/queue, SLA and goodwill defaults, `cartCompatibility()`).
- New worker jobs: `supportSla` (every minute) and `privacySweep` (hourly).

### 10. Customer account management
- **10.1** Admin customer directory with search and filters (status, orders, recency); contact details are masked unless the staff member has `customers.pii`. **W** Customers. **M** `ops/customers`.
- **10.2** Customer 360: orders, complaints, refunds, credits, loyalty, memberships, reservations, saved cards, restrictions, privacy requests and 90-day goodwill. **W** Customers → profile. **M**
- **10.3** `payment_methods` stores the processor token with brand and last 4; raw card numbers are rejected. Customers save, remove and pick a default card; checkout can pay with a saved card. **W** Account → Payments, checkout. **M** `me`, checkout.
- **10.4** Staff send a recovery link (reason required). Duplicate detection on normalized email, phone and address; merging moves orders, reservations, addresses, credits, loyalty, tickets and reviews and disables the source account (reason required, `customers.pii`). **W** (merge); **M** shows duplicates and sends recovery.
- **10.5** Per-topic, per-channel notification preferences (orders, reservations, account, marketing × email, SMS, push). `NotifyService` honors them; in-app and account messages always go. **W** Account → Notifications; admin sees them on the profile. **M** `me`.
- **10.6** Saved platform segments (orders, spend, recency, membership, consent) with live size and CSV export; goodwill cap (setting `support.goodwill`) drives approvals. **W**
- **10.7** Privacy: data export is immediate; deletion is scheduled after a grace period (`privacy.deleteGraceDays`, 14), can be canceled by the customer, executed or blocked by staff, never runs with open orders or chargebacks; the hourly job also anonymizes old guest accounts. Orders and ledger rows are kept anonymized. **W** Account → Privacy, admin Privacy requests. **M** `me`.
- **10.8** Customer restrictions (ordering blocked, promotions blocked, refund review) with reasons, expiry, lift and an appeal flow. Three customer strike points create an ordering block. Checkout returns `ACCOUNT_RESTRICTED`; promo codes are refused under a promotions block; refunds under review need approval. **W** account banner + appeal, admin Appeals. **M** account notice, `me` appeal, `ops/customers` appeals.

### 11. Cart, checkout & order eligibility
- **11.1** Eligibility errors carry codes: `PAUSED`, `CLOSED` (with `nextOpenAt`), `SCHEDULE_TOO_SOON`, `SLOT_FULL`, `DELIVERY_UNAVAILABLE`, `ITEM_UNAVAILABLE`, `SEPARATE_ORDER_REQUIRED`, `ACCOUNT_RESTRICTED`; checkout explains each in plain language. **API W M**
- **11.3** Shared `cartCompatibility()` and `GET /public/cart-compatibility`: Made at Gutad menus mix within one food hall; anything else is a separate order, with the reason. **API W M**
- **11.4** Separate-order handling: adding from another place offers to save the current cart and start a separate order (or replace it). Checkout lists saved carts; the next one opens after an order is placed. **W M**
- **11.5** Scheduled orders respect a per-slot capacity and a minimum lead time per location; discovery hides full slots. **API W M**
- **11.7** A declined card returns `PAYMENT_DECLINED` with the quote id; the customer picks another card and retries on the same quote with a new idempotency key, without a duplicate order. **W M**
- **11.8** Each order snapshot records the cancellation and refund policy versions (setting `policies.versions`). **API**

### 24. Customer support & service recovery
- **24.1** Tickets link to payment, merchant, menu item, order, reservation and delivery. **API W M**
- **24.2** Categories with a default owner, priority and queue, including wrong item, quality, failed delivery, food safety and payment. Food-safety tickets open a critical alert for culinary. **W M** (customer report form with item picker).
- **24.3** First-response and resolution SLAs by priority (setting `support.sla`), breach detection with alerts, queues, priority changes and assignment. **W** Support queue (filters: status, priority, queue, reporter, mine, breached). **M** `ops/support`.
- **24.4** Remedy preview before resolving: refundable amount, prior compensation, goodwill, restrictions, and whether approval is needed and why. **W M**
- **24.5** Repeat compensation on an order, goodwill over the cap, or a customer under refund review always needs a second approver. **API W M**
- **24.6** A merchant or courier can dispute being held responsible; an admin reverses (Gutad absorbs the cost, ledger re-credits the merchant) or upholds. **API W M** (admin side; follow-up 24.6-W for merchant/courier screens).
- **24.7** One conversation per ticket for customers, merchants and staff, with internal notes and approved templates; a staff reply marks first response. **W** order page + admin. **M** order screen + `ops/support`.
- **24.8** Root-cause report by category, dish, merchant, location, kitchen, delivery zone or owner, with compensation, SLA breaches and time to resolve. **W** Support → Root causes.

## Phase F: kitchen display & packing (shipped 2026-11-13)

Verification:
- Typecheck is clean for API, web and mobile; `next build`: OK.
- `npm run smoke` on a fresh database: **312/312 checks pass**, including 16 new Phase F checks in `scripts/smoke-admin-f.mjs`; the existing shared-kitchen check now also ticks the packing checklist.
- Migration `0011_kitchen_packing.sql`:
  - new tables `station_routes`, `kitchen_events`
  - new columns on kitchens (default station, auto-throttle overrides, load level), stations (target minutes), kitchen tickets (kind, fire-at, ready-by, cook minutes, delayed-at), menu items (cook minutes, handling), order lines (handling, ready-at), orders (table number, utensils, shelf slot, handoff, no-show stage), packing tasks (checklist, bags, handling, verified-by, created-at) and locations (pickup shelves, packing extras, packing verification)
- Shared `packages/shared/src/kitchen.ts`: handling flags, kitchen reason codes, auto-throttle and pickup-policy defaults, `fireAt()`, `suggestBags()`, `mentionsAllergy()`.
- New worker jobs `kitchenLoad` and `pickupNoShow` (every minute), with manual triggers `POST /admin/jobs/kitchen-load` and `POST /admin/jobs/pickup-no-show`.
- Fixed: the order response now includes each line's menu item id (the Phase E "which item?" picker needed it).

### 13. Kitchen display & preparation
- **13.1** Item-level bumps: each item on a ticket is bumped (or undone) on its own; the ticket finishes with its last item. **W M** station screens.
- **13.2** Routing rules by item, category or brand (most specific wins), then the item's own station, then the kitchen's default station. **W** Kitchen → Setup.
- **13.3** Cook minutes per item (or the recipe's prep minutes, or the station target) give each station ticket a fire-at time so every station finishes by the ready-by time. Tickets not yet due show "FIRE hh:mm" and can be fired early. **API W M**
- **13.4** Expo board: every active order, the stations still holding it, items ready, finished food waiting and minutes late. **W M** (also in admin Kitchen operations).
- **13.5** Prep targets per station; late tickets are flagged on the screen and by the load job. Performance shows average vs target, on-target share, remakes and ready-to-collected waiting time. **W M**
- **13.6** Remakes, missing items and quality failures with reason codes. Remakes and missing items re-fire as a REMAKE ticket and come out of the bag; "86" records an out-of-stock event. **W M**
- **13.7** Auto-throttle (setting `kitchen.autoThrottle`, per-kitchen overrides): BUSY adds prep minutes to new quotes, OVERLOADED stops ASAP orders (`KITCHEN_BUSY`) and raises an alert; it steps down on recovery and resolves the alert. **API W M** (admin Kitchen operations; checkout explains it).
- **13.8** Degraded mode: the station screen keeps the last known queue on the device and shows an offline banner; bumps made offline are stored and replayed in order when the connection returns; tickets print from the browser; a printable offline runbook covers manual ticket mode. **W M**

### 14. Packing, handoff, pickup & dine-in
- **14.1** Every order gets a packing checklist: location extras (default napkins and receipt), utensils when the customer asked (new checkout option), drinks sealed, allergy label, tamper seal for delivery. **API W M**
- **14.2** Bag count per order with per-bag handling; printable bag labels (bag n of N, handling, allergy notes; the pickup code is never printed). **W** (labels), **M** (bag count).
- **14.3** Handling flags (hot, cold, fragile, allergen) on items, copied to lines (plus allergen when the customer's note mentions an allergy), shown on tickets, packing and labels; hot and cold go in separate bags. **W M**
- **14.4** Every order has a packing task. At kitchen-backed locations (or wherever the location requires it) an order becomes ready only by releasing a verified bag, and the tablet "Ready" button refuses with `PACK_VERIFICATION_REQUIRED`. **API W M**
- **14.5** Pickup shelves per location: released orders get the first free shelf, shown to the customer and on the pickup board, which flags orders waiting past the policy (setting `pickup.policy`). **W M**
- **14.6** Handoff records who received it: customer (code verified), courier (from the delivery job), or table, plus the staff member and time. **API W M**
- **14.7** Pickup no-shows: the customer is reminded after 20 minutes, then the order is resolved by policy after 60 minutes (default: charged and closed as a no-show; or canceled with a merchant-funded refund). **API**
- **14.8** KIOSK channel for quotes and orders (where the location accepts kiosk orders), dine-in table numbers (checkout "Dine in" for QR/`?table=` links), and a runner view to serve orders to tables. **API W M**

## Phase G: delivery areas, couriers, dispatch (shipped 2026-11-13)

Verification:
- Typecheck is clean for API, web and mobile; `next build`: OK.
- `npm run smoke` on a fresh database: **329/329 checks pass**, including 17 new Phase G checks in `scripts/smoke-admin-g.mjs`; the main suite now also checks that public tracking carries no proof of delivery.
- Migration `0012_delivery_couriers.sql`:
  - new tables `delivery_restrictions`, `courier_documents`, `courier_shifts`, `courier_records`, `provider_connections`
  - new columns on delivery zones (kind, shared locations, kitchen, region, travel minutes per km, capacity per hour, hours, fee tiers), drivers (vehicle type, capabilities, region and zones, orders at once, suspension and appeal), delivery jobs (arrival times, batch, offer rounds, requirements, exception, provider chain, zone, distance, proof purge), driver offers (score and detail), driver earnings (kind, reason, created by) and locations (delivery window length and capacity)
- New `DeliveryAdminService`; shared `packages/shared/src/delivery.ts` (vehicle types, capabilities, document kinds, exceptions, dispatch and batching defaults, distance/bearing, map projection and OSM tiles).
- New worker job for courier document expiry and proof retention (hourly), with a manual trigger `POST /admin/jobs/delivery-housekeeping`.
- Web and mobile maps use OpenStreetMap tiles with attribution; no map library was added.

### 15. Delivery areas, promises & capacity
- **15.1** Zones are drawn by clicking on a map. Exclusion polygons carve areas out of service. **W** (merchant Settings → Delivery, admin Delivery → Zones). **M** read-only map in Ops → Delivery.
- **15.2** A zone can also serve other locations of the same merchant, or every location of a kitchen. **API W**
- **15.3** Travel time from distance × minutes per km (per zone), a deliveries-per-hour cap (`ZONE_AT_CAPACITY`), and zone opening hours (`ZONE_CLOSED`). **API W**
- **15.4** Delivery ETA = kitchen prep (including the Phase F busy-kitchen minutes) + travel + courier wait, which grows when few couriers are near the pickup; checkout warns when couriers are busy. **API W M**
- **15.5** Restrictions (pause, shrink radius, add minutes) for a zone, location, region or everywhere, with an end time (at most 7 days) and lift; checkout explains them (`DELIVERY_PAUSED`, `DELIVERY_RESTRICTED`). **API W M**
- **15.6** Scheduled delivery windows with a capacity per window (`WINDOW_FULL`) and a public windows endpoint. **API W**
- **15.7** Distance-tiered fees and minimum orders per zone. **API W**
- **15.8** Coverage simulation for a proposed location: deliverable share, excluded share, share already covered (with overlapping locations) and average/worst ETA. **W** (map).

### 16. Courier & delivery-partner management
- **16.1** Courier directory and profile: operational status (online, on delivery, offline, suspended), vehicle, capabilities, service zones, orders at once. **W M**
- **16.2** Onboarding documents (licence, insurance, background check, registration, ID) with review, rejection notes and expiry. Approval needs the required documents; an expired one takes the courier offline and blocks going online. **API W M**
- **16.3** Vehicle types and capabilities; dispatch only offers alcohol and large orders to capable couriers, and prefers a cold bag for chilled items. **API W M**
- **16.4** Courier shifts (no overlaps, up to 12 hours) with a staff shift board; delivery providers connected per region in failover order. **API W M**
- **16.5** Acceptance, completion, cancellation and on-time rates, and average wait at pickup, per courier. **W M**
- **16.6** Incidents, training records and notes, plus support tickets on the courier's deliveries. **W M**
- **16.7** Bonuses and deductions with a reason, posted to the courier's payable balance in the ledger; earnings history shows payout ids. **W M**
- **16.8** Suspension with a reason (withdraws offers; refused while the courier has active deliveries); the courier appeals; someone other than the person who suspended decides. **API W M**

### 17. Dispatch & last-mile
- **17.1** Live dispatch map: couriers by status, pickup points, drop-offs, problem and late deliveries. **W** map + table, **M** map + list.
- **17.2** Assignment scoring: distance to pickup, gap between travel time and food-ready time, current load, vehicle fit, cold bag; the score and its parts are stored on each offer. **API**
- **17.3** Manual assignment to a chosen courier with a required, audited reason. **W M**
- **17.4** Batching (setting `delivery.batching`): same pickup, not yet picked up, ready within 10 minutes, same direction (within 45°), small detour, at most 2 orders; batched jobs share a batch id. **API W M**
- **17.5** Offer time, offers per round, rounds and radius are configurable (setting `delivery.dispatch`); after the last round the job fails over or raises a dispatcher alert. **API W**
- **17.6** Arrival at pickup and at the drop-off, route pings that refresh the ETA once the order is on its way, and delivery timestamps; the customer sees "Your courier has arrived". **API W M**
- **17.7** Customer unreachable, wrong address (with correction), access problem, unsafe location: each contact attempt is logged, the customer is notified, a wait timer must run out (staff can resolve early), then return, dispose (customer bears the cost) or leave safely with a photo. **API W M**
- **17.8** **Fixed:** proof of delivery is no longer on public tracking, the customer's order view, or delivery emails. Staff and the merchant view it through `GET /delivery-jobs/:id/proof`, and every view is audited (support's chargeback evidence too). Proof is removed after `proofRetentionDays` (90) unless the order has an open support ticket. **API W M**
- **17.9** Provider failover: own fleet → the configured partner provider (per region, by priority), with the provider chain recorded on the job. **API W**
- **17.10** Analysis by zone, provider or location: on-time share, courier wait at pickup, drive time, distance, cost per delivery, total cost, fees and subsidy. **W**

## Phase H: payments, settlement, accounting (shipped 2026-11-13)

Verification:
- Typecheck is clean for API, web and mobile; `next build`: OK.
- `npm run smoke` on a fresh database: **348/348 checks pass**, including 19 new Phase H checks in `scripts/smoke-admin-h.mjs`.
- Migration `0013_finance_controls.sql`:
  - new ledger accounts DISPUTE_RECEIVABLE, DEFERRED_REVENUE, PLATFORM_REVENUE_BREAKAGE, SUPPLIER_PAYABLE, INVENTORY, PLATFORM_ADJUSTMENTS
  - new tables `payment_failures`, `disputes`, `payout_batches`, `statement_disputes`, `gl_accounts`, `close_periods`, `budgets`
  - new columns on payments (split, retry count, last failure), refunds (allocation), payouts (batch), legal sellers (payout hold until) and purchase orders (bill due, bill paid)
- New `FinanceModule` (`FinanceService` for payments operations, `AccountingService`); `SettlementService` gains batches, holds, reprocessing, transfer reconciliation, adjustments, statement disputes, ledger explorer, liabilities and royalty statements. Shared `packages/shared/src/finance.ts`.
- **Fixed:** a merchant statement subtracted the previous payout again, so the next payout was short by the last payout's amount. Payout postings are now excluded from statements (a returned transfer re-opens the same payout instead).
- Also done here: 2.6-P (payout release through the approval engine), 6.3-S (royalty accrual uses the brand's royalty rules), 16.7-P (courier payouts released in batches).

### 18. Payments & transaction operations
- **18.1** Payments console: search by order, intent, charge or id; status and purpose filters; 30-day totals; detail with split, refunds, dispute and ledger lines. Failed attempts (declines) are recorded even though the order rolls back. **W** Payments. **M** Ops → Finance.
- **18.2** Enabled payment methods per region and channel (setting `payments.methods`); public endpoint for checkout; credits and points are refused where disabled (`METHOD_DISABLED`). **API W**
- **18.3** Each order payment records its split (card, credits, points; gift balance since Phase J, see 18.3-G). **API W**
- **18.4** Capture retry for open authorizations on accepted orders, capped (`finance.controls.maxCaptureRetries`); duplicate-charge report (same customer and amount within 5 minutes). **API W**
- **18.5** Partial refunds are allocated back to the card and to credits in proportion to how the order was paid. **API W**
- **18.6** Processor settlement file upload (CSV) and an unresolved-payments view (captured but unsettled, stale authorizations, unmatched lines). **W M**
- **18.7** Disputes table from the processor webhook with an evidence deadline; the withdrawn funds move to DISPUTE_RECEIVABLE; the evidence packet comes from the order timeline (audited proof access); WON returns the funds, LOST books the loss to Gutad or the merchant. **API W M**
- **18.8** Webhook monitor (rate, failures, pending, lag) and replay with a dry run first; replays are audited. **W M**
- **18.9** Card numbers are never typed into Gutad: web and mobile checkout, saved cards, reservations, tickets and event deposits use a token field (test-card picker in test mode); the console masks payment-method ids and never returns client secrets. **W M**

### 19. Merchant settlement, royalties & courier payouts
- **19.1** Ledger explorer (account, party, order, batch, date) with totals and batch drill-down. **W**
- **19.2** Merchant statements itemized by category (sales, tips, commission, promotions, refunds, credits, cover fees, delivery, royalties, adjustments, disputes). **W** merchant Finance, **M** merchant Finance.
- **19.3** Brand royalty statements for a period from the brand's royalty rules, by channel. **W**
- **19.4** Payout batches: eligible payouts are batched; above `approvals.thresholds.payoutCents` a PAYOUT_RELEASE approval is requested and a different person releases it. The weekly run batches automatically; a batch over the limit waits as a draft until finance requests release. **API W M**
- **19.5** Processor transfer report reconciliation: a returned transfer re-opens the payable on the same payout; unknown transfers go to the unmatched queue. **W**
- **19.6** Held or failed payouts can be reprocessed with a reason (attempts reset); held payouts are released automatically when their hold ends. **W M**
- **19.7** Manual ledger-posted adjustments with a reason, and merchant statement disputes that finance accepts (with an adjustment) or rejects. **W M**
- **19.8** Liabilities vs revenue: merchant, courier, provider, supplier, tax, credit, deposit and deferred-revenue balances; largest merchant balances; bank and clearing. **W M**
- **19.9** Bank-detail changes (two-person, from Phase A) now start a cooling-off hold (`finance.controls.bankChangeHoldDays`, 3): payouts to the new account are HELD until it ends. **API W M**

### 20. Accounting, treasury & financial control
- **20.1** Chart-of-accounts mapping (ledger account → GL code and name per legal entity, with defaults) and a journal export in a general-journal CSV layout. **W**
- **20.2** P&L by location, legal entity, channel or brand (brand splits order-level lines by the brand's share of the order). **W**
- **20.3** Cost report: food cost (COGS posted from recipes when Gutad-operated kitchens fire an order), labor, delivery and processing. **W**
- **20.4** Credit liability report (outstanding, expiring, by funder, ledger balance) and breakage: expired credits post to breakage revenue (daily job, or on demand). Gift-card liability added in Phase J (20.4-G). **W**
- **20.5** Straight-line deferred-revenue schedule for subscriptions and memberships, net of refunds, with an idempotent true-up posting. **W**
- **20.6** Supplier bills from received purchase orders at Gutad-operated kitchens (inventory and accounts payable), bill payment, and receivables / payables aging. **W**
- **20.7** 14-day cash forecast, bank reconciliation view, and a month-end close checklist with automatic checks that blocks closing until everything is done. **W**
- **20.8** Budgets by cost center and category with budget vs actual, the approval limits in force, and a financial audit export (journal and finance-related audit log). **W**

## Phase I: supply, safety, workforce (shipped 2026-11-13)

Verification:
- Typecheck is clean for API, web and mobile; `next build`: OK.
- `npm run smoke` on a fresh database: **368/368 checks pass**, including 20 new Phase I checks in `scripts/smoke-admin-i.mjs`. The Phase E slot-capacity check now uses a midday slot two days out (it could collide with another test's order around midnight).
- Migration `0014_supply_safety_workforce.sql`:
  - new tables `storage_areas`, `stock_lots`, `stock_movements`, `suppliers`, `stock_transfers`, `temperature_logs`, `checklist_templates`, `checklist_runs`, `recalls`, `inspections`, `corrective_actions`, `staff_shifts`, `staff_skills`, `time_entries`, `equipment`, `equipment_tickets`
  - new columns on ingredients (type, purchase unit and factor, supplier, shelf life, storage temperatures), ingredient stock (safety stock), purchase orders (supplier, expected date, invoice and match), purchase-order lines (discrepancy), menu items (sold-out source), stations (required skill) and devices (firmware, app version, last error, offline alert)
- New `OperationsModule` (`InventoryService`, `SafetyService`, `WorkforceService`); the kitchen stock core (lots, first-expiring-first-out, movements, auto-restore) lives in `KitchenService`. Shared `packages/shared/src/operations.ts`.
- New worker jobs: lot expiry (hourly), illness-cluster detection (every 15 minutes), device health (every 5 minutes), equipment service due (daily); manual trigger `POST /admin/jobs/operations-sweep`.
- Also done here: 1.6-L (contribution uses actual labor hours where a kitchen records them) and 8.5-K (recipe batch limits lengthen cook time when an order exceeds the batch size).

### 21. Inventory, procurement & warehouse
- **21.1** Item masters: type (ingredient, prepared component, packaging, consumable), organization ownership (shared catalog stays Gutad-only). **W**
- **21.2** Units and conversions (shared table) and purchase units (a "kg" buys 1000 g); expected consumption for planned portions from recipes. **API W**
- **21.3** Storage areas (warehouse, dry, cold, freezer, kitchen) with temperature ranges; lots with lot code, supplier, storage area, quantity left and expiry. **W M**
- **21.4** Stock movements ledger: receipts, consumption (per order), transfers out/in, counts, adjustments, spoilage, withdrawals; counts post the difference. **W M**
- **21.5** First-expiring-first-out: orders, waste and transfers take the earliest-expiring available lots; expired lots leave stock as spoilage; pick suggestions. **W M**
- **21.6** Demand forecast (average use by weekday over 4 weeks), safety stock (setting or 2 days of use), reorder point by supplier lead time, and replenishment proposals turned into draft purchase orders per approved supplier. **W M** (read)
- **21.7** Supplier records (contact, lead time, delivery days, specifications), expected delivery dates, late deliveries, receiving discrepancies (short / over / damaged). **W M**
- **21.8** Three-way match: purchase order ↔ goods received ↔ supplier invoice, per line and in total, within a tolerance (`procurement.matchTolerancePct`, 2%). **W**
- **21.9** Transfers between a merchant's sites: request, pick (first expiring first out), ship, receive with lots and expiry carried over; differences recorded. **W M**
- **21.10** An ingredient running out sells out the dishes that use it at that kitchen (marked STOCKOUT), and receipts, transfers and counts bring them back automatically. **API**
- **21.11** Reports: forecast accuracy, waste by item and reason, supplier on-time / fill rate / invoice variances, inventory valuation, value expiring in 3 days. **W M**

### 22. Food safety, quality & recalls
- **22.1** Approved suppliers and product specifications; purchase orders to an unapproved supplier are refused; a specification change sends the supplier back for approval. **API W**
- **22.2** Receiving and storage temperature logs against the storage area, ingredient spec or defaults; out of range raises an alert and a corrective action, and warm deliveries are quarantined. **W M**
- **22.3** Checklist templates (defaults for opening, closing and allergen handling, plus custom) and signed completions; missed steps raise a corrective action. **W M**
- **22.4** Allergen review queue for dishes flagged by recipe changes (8.8), with an audited sign-off of the allergen list. **W**
- **22.5** Lot traceability: lot → orders and locations (including lots moved by transfer), and order → lots, suppliers and expiry. **W M**
- **22.6** Recalls: quarantine lots, stop-sell every dish using the ingredient where those lots are, notify the customers of affected orders, withdraw the stock, close (dishes come back). **W M**
- **22.7** Food-safety reports go to culinary with an immediate alert (Phase E), and two or more within 72 hours at one location or for one dish raise a possible-cluster alert; each report can be traced to the lots used. **W M**
- **22.8** Inspections (internal, health department, third party) with findings that become corrective actions; completion needs evidence and a second person verifies. **W M**

### 23. Workforce, training & equipment
- **23.1** Staffing forecast per hour from the weekday's order volume (`workforce.config.ordersPerStaffHour`) against scheduled shifts; shift scheduling by location and station. **W**
- **23.2** Skills and certifications with expiry; a station can require a skill and only takes shifts from people holding it. **W**
- **23.3** Clock in/out (one open entry), manager approval by someone else, edits audited, payroll CSV with weekly overtime; clock-out hours also feed kitchen labor. **W M**
- **23.4** Labor hours vs order volume per day: orders per labor hour and labor as a share of sales. **W**
- **23.5** Equipment register with service intervals, service and fault tickets, service due alerts. **W M**
- **23.6** Equipment down or in maintenance takes the dishes that need it off the menu and closes its station (or halves capacity when other equipment works there); back in service restores exactly what changed. **W M**
- **23.7** Device health: heartbeats record firmware, app version and errors; devices silent for 10 minutes go offline with one alert, which closes when they return. **W M**
- **23.8** Automated equipment: approved software versions (`equipment.approvedVersions`), a fault feed from the kitchen's device token, alerts to an operator. Record and escalate only; Gutad never sends commands to the machine. **API W M**

## Phase J: growth (shipped 2026-11-14)

Verification:
- Typecheck is clean for shared, API, web and mobile; `next build`: OK.
- `npm run smoke` on a fresh database: **406/406 checks pass**, including 38 new Phase J checks in `scripts/smoke-admin-j.mjs`. Phase H's payment-methods check now restores the default list with GIFT_CARD.
- Migration `0015_growth_offers_rewards_giftcards.sql`:
  - new ledger account GIFT_CARD_LIABILITY
  - new tables `offer_redemptions`, `referrals`, `challenges`, `challenge_progress`, `gift_cards`, `gift_card_txns`, `campaign_assignments`
  - new columns on coupons (name, owner, automatic, segment, first order, items, categories, days, daypart, cap, stacking, priority), campaigns (holdout share; organization now optional for Gutad-wide campaigns), membership plans (trial days) and member subscriptions (trial end, cancel at period end, card, next retry, grace, last failure)
- `GrowthModule` now has `GrowthService` (offers engine, campaigns and holdouts, loyalty, memberships), `RewardsService` (referrals, challenges) and `GiftCardsService`; gift balance as a tender lives in `modules/growth/gift-tender.ts` so checkout, cancellations and refunds share it. Shared `packages/shared/src/growth.ts`.
- Seed: the Gutad+ monthly plan has a 7-day trial; a paused weekday-lunch offer and a paused "3 orders in 14 days" challenge as examples; settings `giftcards.limits`, `membership.dunning`, `growth.referrals`, `growth.contributionMarginBps`.
- Jobs: the daily job also expires challenge windows and now retries past-due memberships on schedule; manual trigger `POST /admin/jobs/growth` (`at` only with `ALLOW_BILLING_TIME_TRAVEL=true`).
- **Fixed:**
  - Failed membership renewals were never retried: a past-due membership was not picked up by the renewal run again. It now retries on a schedule (1, 3, 5 days by default) and is suspended after the last try (25.8).
  - Referral rewards were paid as soon as a code was entered (25.5).
  - Delivered orders never earned loyalty points; delivery completion now runs the same completion steps as pickup (points, referral, challenges).
  - An order paid entirely by credits, points or gift balance could not be canceled before acceptance (the void refused the placeholder payment), and when accepted it posted no settlement journal, so the merchant was never credited. Both fixed.
- Also done here: 11.6 (payment mix), 18.3-G (gift split and refund allocation), 20.4-G (gift-card liability in the liability reports).

### 25. Promotions, rewards, referrals & memberships
- **25.1** Automatic (codeless) offers alongside codes, Gutad-wide or per merchant, shown on the restaurant page and applied at checkout; the checkout lists each promotion by name. **API W M**
- **25.2** Eligibility: customer segment (saved platform segments), first order, merchant and locations, items or whole categories, days of the week and a daypart in the restaurant's local time, minimum subtotal, cap, uses per customer and in total. A code that doesn't apply says why. **API W**
- **25.3** Stacking: exclusive offers stand alone, stackable ones combine in priority order and never exceed the subtotal. Without a code the customer gets the better of the best exclusive offer and all stackable ones; a typed code always applies, and an exclusive code replaces automatic offers with a note. **API W**
- **25.4** Each promotion carries its funding (Gutad, merchant or a split share, 9.6); accepted orders record one redemption per promotion with Gutad- and merchant-funded amounts. Promotion cost report for Gutad and for each merchant: orders, customers, discount, funding split, sales, cost as a share of sales, plus the ledger promotion expense. Canceled orders drop out and free the use. **API W M** (read)
- **25.5** Referrals: the code is recorded, and both sides get points only after the new customer's first completed order. A shared phone, card or delivery address between the two accounts holds the reward for review (approve or reject with a note, on web or phone). Codes only work before a first order, once per customer. **API W M**
- **25.6** Reward challenges (e.g. 3 orders in 14 days) by Gutad or a merchant: qualifying orders (location, minimum), a window that starts with the first qualifying order, progress for the customer, completion limit, and an expiring credit (merchant- or Gutad-funded) when the goal is reached. **API W M**
- **25.7** Membership trials for first-time members (card required, charged when the trial ends), cancel at the end of the period with benefits until then, undo the cancellation, change card. **API W M**
- **25.8** Failed renewals: past due with retries after 1, 3 and 5 days (`membership.dunning`), benefits for a 7-day grace period, a message on each failure, suspension after the last retry. Updating the card retries at once; staff can retry from the console or phone; recoveries are counted. **API W M**
- **25.9** Gift cards: buy for yourself or someone (email delivery), promotional cards issued by Gutad, add a code to the wallet, spend the balance at checkout, activity history. Balances are a liability until the order is captured. Fraud controls: per-buyer purchase limits per day, large cards wait for a second person, a customer is locked out for an hour after repeated wrong codes, staff can lock, unlock and void cards, and a fraud watch lists buyers with several cards and blocked attempts. **API W M**
- **25.10** Campaign holdouts: a share of customers (up to 50%) is assigned to a holdout group the first time they meet the campaign, never sees its offers or messages, and is compared with the campaign group over the same window: incremental orders and sales, promotion cost, profit at the contribution margin (`growth.contributionMarginBps`), ROI. **API W M** (read)

### Follow-ups completed with Phase J
- **11.6** Payment mix at checkout: credits, then points, then gift balance, then the card; the summary shows the order total, each tender and what the card pays. Gift-only orders need no card. **API W M**
- **18.3-G** The order's payment split records the gift share; allocated refunds return money to the card, credits and gift cards in proportion, and cancellations return gift money to the cards it came from (after capture, charged to whoever bears the refund). **API W**
- **20.4-G** Gift-card liability (outstanding, ledger balance, not yet in a wallet, spent in 30 days) in Accounting → Balances and in the liabilities report. **API W**

## Follow-ups across phases A–J (shipped 2026-11-14)

Verification:
- Typecheck clean for shared, API, web and mobile; `next build`: OK.
- `npm run smoke` on a fresh database: **481/481 checks pass**, including 75 new checks in `scripts/smoke-followups-{a,b,c,d}.mjs`.
- Migration `0016_followups_all.sql`. New tables: `user_devices`, `location_load_settings`, `printers`, `print_jobs`, `stored_files`, `gl_connections`, `gl_push_batches`, `supplier_access_tokens`, `supplier_invoice_submissions`, `temperature_sensors`, `payroll_connections`, `payroll_export_batches`, `equipment_vendor_links`, `equipment_vendor_events`. New columns on customer restrictions (limit, period), courier documents (stored file), close periods (reopen), coupons (buy/get quantities), member subscriptions (pending plan).
- External providers are optional adapters that keep today's behaviour until configured: Stripe Elements / hosted setup, TaxJar / Avalara, OSRM / Google / Mapbox routing, QuickBooks / Xero, Gusto / ADP, Rational / Welbilt, S3-compatible storage, ESC/POS network printers. Their real API calls were written against the public API shapes and **have not been run against those services**; the mock / default paths are what the smoke tests cover.
- Production: courier document uploads go to the bundled private MinIO bucket `gutad-files` (set up by `deploy.sh`, backed up nightly); full smoke 481/481 with `STORAGE_DRIVER=s3` against MinIO.
- **Fixed:** campaign results no longer drop the newest orders when the database clock runs ahead of the app server; `GIFT_CARD_LIABILITY` was missing from the default GL map (unmapped in the CSV export).

### Phase A–E follow-ups
- **2.4c-M** SSO on mobile: system-browser OIDC flow (`expo-web-browser` + deep link `gutad://auth/sso`), one-time verifier so a stolen code can't be redeemed, optional `security.sso.mobileRedirectUri`. **API M**
- **4.3-T** Smoke check for document expiry (upload, approve with expiry, sweep, reminder once); `POST /admin/jobs/document-expiry`. **API**
- **5.1-L** Admin merchant page invites staff with a location picker and an approval limit. **W**
- **7.7-M** Menu versions include modifier groups and options (publish, rollback, diff; shared groups are copied, never edited). **API W**
- **9.5-X** External tax provider adapter (TaxJar, Avalara, mock) behind `TAX_PROVIDER`, cached, falling back to the built-in rates with a warning; the pricing page shows the active engine. **API W**
- **10.3-P / 18.9-S** Processor tokenization: SetupIntent / Elements on web, hosted setup page on mobile, `/me/payment-methods/setup`; test mode unchanged. With the live processor, guest checkout on mobile needs a signed-in user. **API W M**
- **10.4-D** Hashed device id (sent as `X-Device-Id` by web and mobile) recorded at sign-in and used as a duplicate-account signal; devices listed in customer 360. **API W M**
- **10.8-L** Cash and credit limits per customer (per order or rolling window), enforced at quote and re-checked at checkout. **API W**
- **24.6-W** Merchants (web and phone) and couriers (phone) see tickets charged to them and dispute once; only owners/managers or the courier can dispute. **API W M**

### Phase F–G follow-ups
- **13.7-L** Auto-throttle for restaurants without a production kitchen (open orders × prep time ÷ parallel capacity), busy and overloaded levels, alerts; off by default (`orders.locationThrottle`). **API W**
- **13.8-P** Network ticket printers: registry, ESC/POS raw TCP and log adapters, print queue with retries, auto-print on fan-out, test print, print buttons. **API W**
- **14.8-K** Full-screen kiosk mode on web (`/kiosk/[slug]`) and mobile (`kiosk/[slug]`) with pager/table number, idle reset and pay by card or at the counter. **W M**
- **15.3-R** Road-network travel times from OSRM, Google or Mapbox (`ROUTING_PROVIDER`), cached, falling back to straight-line. **API**
- **16.2-U** Courier documents uploaded directly to storage (local or S3-compatible), content checked, signed links for staff. **API W M**
- **17.1-R** Live map pushed over server-sent events (Redis pub/sub) to admin, merchant dispatch and the ops app, with polling as fallback. **API W M**
- **17.9-M** Several partner providers in priority order with failover on dispatch failure; with none left the job goes to a dispatcher. **API**

### Phase H–I follow-ups
- **20.1-L** Live journal push to QuickBooks Online or Xero per closed month, batches with retry, idempotent per entity and period; CSV stays the default. **API**
- **20.7-L** Postings dated in a closed month are redirected to the open month (or refused, `accounting.ledgerLock`); audited reopen. **API**
- **21.6-S** Forecast adds trend, same-period-last-year and promotion uplift (`inventory.forecast`), shown in the supply forecast. **API**
- **21.8-P** Supplier portal (per-supplier token) and EDI 810 / CSV upload feeding the three-way match. **API W**
- **22.2-S** Wireless temperature sensors (token ingest) feed storage logs with the same alerts and corrective actions; offline sensor alerts. **API W M**
- **23.3-P** Payroll push to Gusto or ADP per pay period with batches and retry; CSV export kept. **API W**
- **23.8-V** Equipment vendor feeds (Rational, Welbilt, generic): telemetry, maintenance and faults recorded and alerted; still no commands to machines. **API**

### Phase J follow-ups
- **25.1-B** Buy X get Y free (cheapest units free) and free-item offers. **API W**
- **25.7-P** Switch membership plans: upgrades now with credit for unused time, downgrades at renewal. Staff can set free-trial days per plan in Pricing. **API W M**
- **25.9-M** Buy gift cards in the mobile app. **M**
- **25.9-E** Unclaimed-property (escheat) report by state with dormancy rules (`giftcards.escheat`) and CSV. **API W**
- **25.10-P** Gutad-wide email/SMS campaigns to platform customer segments (marketing consent only) with a holdout. **API W**
- **25.10-S** 95% ranges on incremental orders and sales, flagged when not conclusive. **API W**


## Phase K: users, roles & permissions (IAM) (shipped 2026-11-14)

Plan and gap analysis: [`IAM-PLAN.md`](IAM-PLAN.md). Web `/admin/iam`, mobile Ops → Users & access. Smoke: 67 new checks (`scripts/smoke-iam.mjs`), 548/548 overall.

- **K.1 User management**: create and invite staff, profile fields, activate / suspend (optionally until a date) / deactivate / archive, resend and revoke invitations, public invitation acceptance (`/account/invite`), bulk CSV import with dry run, staff CSV export. **API W M**
- **K.2 Roles**: database roles (9 built-in, seeded with their previous access, plus custom); create, edit, duplicate, archive unused, restore; several roles per person. **API W**
- **K.3–K.4 Permissions & matrix**: 20 resources × view/create/edit/delete/approve/publish/export/refund/manage access; checkbox matrix saved in one batch; coarse console checks are narrowed to the request's action. **API W**
- **K.5 Scope**: companies, kitchens, brands and teams join regions, organizations, locations and the sensitivity ceiling; changes apply immediately. **API W**
- **K.6 Assignments**: primary role and responsibility, scheduled start, end date, bulk assignment, removal; live without re-login. **API W M**
- **K.7 Data restrictions**: personal info, bank & payout details, pay rates & payroll, financial reports; masked fields and gated report/export routes; export controlled separately. **API W**
- **K.8 Approval authority**: per-role limits for refunds, discounts/credits, purchase orders, payouts and refunds without approval; enforced when deciding. **API W**
- **K.9 Separation of duties**: no self-assignment, self-approval, self-review or self-status change; no granting permissions you don't hold; a second superadmin for critical changes. **API W**
- **K.10 Login security**: lockout per account and per IP, sign-in event log, admin unlock (SSO/MFA/recovery from Phase A). **API W M**
- **K.11 Sessions**: all staff sessions, end one, force sign-out, sign out all staff; inactivity timeout enforced on every request. **API W M**
- **K.12 Temporary access**: time-limited roles, acting-manager cover, automatic expiry (plus Phase A emergency access). **API W**
- **K.13 Access requests**: request with justification and duration, approve/reject, status tracking, expiry. **API W M**
- **K.14 Audit**: `iam.*` actions for every access change, with reasons; sign-in events. **API W**
- **K.15 Access reviews**: campaigns with flags, keep/revoke/suspend, periodic automatic campaigns, inactive-account flags and optional auto-suspend. **API W**
- **K.16 Offboarding**: one-step disable and revocation with transfer of pending approvals, tickets, alerts, pipeline, accounts and service accounts. **API W**
- **K.17 Effective access**: per-permission grant/deny with roles and reasons; explain for one permission in an organization or location. **API W M**
- **K.18 Superadmin safeguards**: granter allowlist, last-superadmin lock, step-up verification, dual control, superadmin role locked. **API W**
- **K.19 Service accounts & API keys**: own permissions and organization scope, IP allowlist, expiring hashed keys, rotation with grace period, revocation. **API W**
- **K.20 Security notifications**: alert feed with email/push for privilege increases, new superadmins, suspicious sign-ins, lockouts, sensitive and API access changes, expiring keys, inactive accounts and offboarding. **API W M**
