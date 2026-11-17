# Gutad Chef Network: design as built

Independent chefs sell through Gutad. Customers see **“Gutad’s &lt;dish&gt; — by &lt;chef&gt;”**: Gutad is the seller, and the chef stays visible. Dishes are fixed or customizable, can take special requests, and are ordered for a day (often days or weeks ahead). Gutad charges the customer at checkout, holds the money until the order is completed, then pays the chef in the weekly settlement.

Delivery history and checklists: [`CHEF-NETWORK-TRACKER.md`](CHEF-NETWORK-TRACKER.md). Money flow: [`ARCHITECTURE.md`](ARCHITECTURE.md#gutad-chef-network-prepaid-orders). Smoke checks: `scripts/smoke-chef-a.mjs` … `smoke-chef-h.mjs`.

## Agreed decisions

| Decision | Choice |
|---|---|
| What a chef is | A merchant tenant: `organizations.kind='CHEF'`, a `legal_sellers` row (payouts), an approved kitchen `locations` row (`chef_kitchen=true`) and a `chef_profiles` row |
| When the customer pays | In full at checkout, as a platform charge (never a destination charge), so orders more than 7 days out work. No authorization holds |
| Refunds | Full refund if the chef declines or doesn't confirm in time, and for any cancellation before the date's order cutoff. After the cutoff the chef's late-refund percentage applies, within Gutad's range |
| Several chefs in one cart | One payment, split into one child order per kitchen (“N deliveries”) |
| Changing a paid order | Allowed until the cutoff: the changed order is charged and the original refunded in full; the chef confirms the changed order again |
| Surfaces | Web and full mobile for customers, chefs and Gutad operations |

## Lifecycle of a chef

1. **Apply** (`/chefs/apply`, mobile `chefs/apply`): a 9-step resumable application with autosave. Documents are requested by state and kitchen type (`chef_doc_requirements`). Files go to private object storage.
2. **Review** (Admin → Chef Network → Applications): automated completeness checks, a reviewer, change requests, approve / reject (with appeal) / waitlist. Approval provisions the organization, seller, kitchen location and chef profile, and grants the CHEF role.
3. **Set up**: connect payouts, upload a portrait, build dishes (Gutad reviews each dish and any material edit), set the cooking calendar, then switch availability on.
4. **Operate**: accept orders, answer special requests, keep documents current. The chef sees their earnings and quality record.
5. **Compliance and quality**: an expired required document pauses the chef automatically until a renewal is approved. A food-safety report suspends the dish. Staff can warn, put on probation, suspend and reinstate.

## Ordering

- **Dishes**: FIXED or CUSTOMIZABLE. Option groups (single, level, multi, quantity, included/locked), conditional groups, per-context rules, extras from the chef's approved catalog, and allergen and dietary effects are all evaluated by `evaluateCustomization` (`packages/shared/src/customization.ts`) on web, mobile and the API.
- **Days and capacity** (`ChefCalendarService`): a date can be ordered until (date − notice days) at the cutoff hour, kitchen time. Cooking days, per-date overrides, time away, per-dish and kitchen daily limits apply. A quote holds the portions for 10 minutes and checkout confirms them (`kitchen_capacity_ledger`). The ledger is protected by an advisory lock per kitchen and date.
- **Special requests** (`ChefRequestsService`): customer request → chef quote (versioned) / suggested alternative / question / decline → customer accept and pay / ask for changes / withdraw. An accepted quote becomes a cart line (`chefRequestQuoteId`), priced from the quote, with quantity and day fixed, used once, and only by its customer. Deadlines expire unanswered requests and unaccepted quotes. Escalation: a reminder to the chef at 50% of the window, then an ops alert 4 hours before the deadline.
- **Checkout**: `POST /orders` (one chef) or `POST /checkout-groups` (up to 6 chefs, one charge). The chef must confirm by `accept_by` (min of now + accept hours and order time − 2 h, at least 30 minutes). Otherwise the order is declined and refunded automatically.
- **Reorder** (`POST /orders/:id/reorder` with `{ mode: 'cart' }`): the past order is checked against today's menu. Unavailable, sold-out and special-request lines are left out with a reason; options that no longer fit fall back to defaults; current prices are used and changes are listed. Chef kitchens return the next open date.
- **Changing a paid order** (`GET /orders/:id/amendment`, `POST /orders/:id/amend`): until the cutoff, unless the order has a special-request line. The change is priced with `replacesOrderId`, so the original's portions don't count against the day (the calendar does the same for its owner). Confirming places a new order (`amended_from_order_id`), charges it, and then refunds the original in full, all in one transaction; a declined card changes nothing.

## Money

See ARCHITECTURE. In short: charge → `DEFERRED_REVENUE` per order; completion (or the kept part of a late cancellation) → `MERCHANT_PAYABLE` (food + tax − commission), Gutad commission and fees; refunds before completion come out of `DEFERRED_REVENUE`. Weekly settlement pays only what has been recognized. Staff adjustments post between `PLATFORM_ADJUSTMENTS` and `MERCHANT_PAYABLE`.

## Settings (Admin → Chef Network → Fees & policy)

| Key | Contents | Default |
|---|---|---|
| `fees.chef_network` | commission bps; customer fee scope (service %, min, cap, small order) — approval-gated | 15%; 8%, $1.99–$7.99; under $15 = $2.99 |
| `chefs.policy` | hours to accept; late-refund min / max / default % | 12 h; 0 / 100 / 0 |
| `chefs.max_advance_days` | how far ahead any chef can open dates | 60 |
| `chefs.requests` | chef response hours, quote validity, customer reply hours, open requests per customer, reminder %, escalation hours | 24, 48, 72, 5, 50%, 4 |
| `chefs.quality` | window, minimum orders, max incident % and decline %, food-safety action, expired-document action, reminder days | 30 d, 10, 10%, 20%, suspend dish, pause chef, [30, 7] |
| `chefs.open_regions` | regions taking applications (others are waitlisted) | — |

## Jobs (worker, each under a Redis lock)

| Every | Job |
|---|---|
| 1 min | expire unconfirmed chef orders (refund in full); recognize completed prepaid orders |
| 5 min | release lapsed capacity holds; special-request reminders, escalation and expiry; quality sweep (food-safety actions, threshold flags) |
| 1 h | document expiry, reminders, automatic pause and reinstatement |

Manual triggers for operations and tests: `POST /admin/jobs/chef-requests`, `POST /admin/jobs/chef-operations` (both accept `at` when `ALLOW_BILLING_TIME_TRAVEL=true`).

## Permissions

Staff use `chefs.read` (applications, dishes, kitchens, quality, analytics, requests) and `chefs.manage` (decisions, suspensions, document review, quality actions, request extensions and closing). Earnings adjustments need `finance.manage`. Chefs see only their own organization (`assertOrgAccess`). KITCHEN_ASSISTANT members get tickets and orders.

## Surfaces

| Who | Web | Mobile |
|---|---|---|
| Customer | `/chefs`, `/chefs/[slug]`, `/chefs/dish/[id]`, `/checkout`, `/checkout/chefs`, `/orders/[id]` (+ `/change`), `/orders/group/[id]`, `/account` → Special requests, `/account/requests/[id]` | `chefs`, `chefs/[slug]`, `chefs/dish/[id]`, `checkout`, `checkout-chefs`, `order/[id]` (+ change), `requests/*` |
| Chef | `/chefs/apply`, `/chef` (dashboard, dishes, extras, requests, calendar, profile, earnings, documents & quality), merchant orders, kitchen and finance | `chefs/apply`, `chef/*` (dashboard, dishes, calendar, requests, earnings, compliance) |
| Gutad | `/admin/chefs` (applications, dish review, chefs, kitchens & documents, quality, fees & policy), `/admin/chefs/requests`, `/admin/chefs/analytics`, `/admin/chefs/requirements` | `ops/chefs`, `ops/chef-requests`, `ops/chef-kitchens`, `ops/chef-quality`, `ops/chef-analytics` |

## Deferred

- AI that turns free text (“less sauce, extra mushrooms”) into proposed option selections.
- Adding new dishes while changing a paid order (today: change quantities, remove dishes, change day and time; otherwise cancel and reorder).
- Automatic suspension on quality rates (rates only flag; staff decide).
- Chef-to-chef alternatives suggested by Gutad staff have an API (`POST /admin/chef-requests/:id/quote` with another chef's dish) but no screen.
