# Gutad Chef Network — tracker

Goal: an Uber-style managed marketplace of independent chefs. Dishes sell as **“Gutad’s &lt;dish&gt; — by &lt;chef&gt;”**. They can be fixed or customizable, accept special-request quotes, and be ordered days or weeks ahead. Gutad charges admin-configured fees and pays chefs through Stripe Connect. Started 2026-11-16.

## Agreed decisions
- A chef is a merchant tenant: `organizations.kind='CHEF'` + `legal_sellers` (payouts) + an approved kitchen `locations` row (`chef_kitchen=true`) + `chef_profiles`.
- Chef orders are **charged in full at checkout** (no authorization hold, so orders more than 7 days out work). Refunds follow the cutoff policy. A chef decline or an unanswered order is refunded in full automatically.
- One checkout can span several chefs. It is split into child orders, one per kitchen, and shows “N deliveries” before payment.
- Delivery is phase by phase; each phase is deployed. Web plus full mobile (customer, chef, ops).
- Money flow: the platform charges the customer (no destination charge). Each chef order credits MERCHANT_PAYABLE net of commission, and weekly settlement transfers after completion.

## Phase 1 — Foundations & onboarding [x]
- [x] CHEF and KITCHEN_ASSISTANT roles. Staff permissions `chefs.read` / `chefs.manage`, the IAM resource `chefs`, and grants for the existing system roles (migration 0018).
- [x] Tables `chef_applications`, `chef_doc_requirements` (seeded defaults by kitchen type), `chef_documents`, `chef_profiles`; `locations.chef_kitchen`.
- [x] Resumable application in 9 steps with per-step autosave, completeness/progress (`chefApplicationMissing` in `@gutad/shared`), and documents requested by state and kitchen type.
- [x] Files in object storage (`stored_files`): private documents (owner and reviewers, audited, 5-minute signed links) and public photos.
- [x] Automated checks at submission: completeness, duplicate phone, and region waitlist (setting `chefs.open_regions`).
- [x] Admin pipeline: queues, reviewer assignment, document review, change requests by step, approve, waitlist or decline with a reason, appeal.
- [x] Approval requires every required document approved and current. It provisions the org, seller, kitchen location (paused), opening hours and profile, adds the CHEF role, and sends an email.
- [x] Chef dashboard: checklist, hosted payout onboarding, availability switch (requires payouts), and profile editing. Public directory `/chefs` and storefront `/chefs/[slug]`. Admin suspend, pause and reinstate.
- [x] Web: `/chefs/apply` wizard (step nav, progress, autosave, drag-or-click uploads), `/chef`, `/chef/profile`, `/admin/chefs`, `/admin/chefs/requirements`.
- [x] Mobile: `chefs/apply` (camera/library uploads via expo-image-picker), `chef/index`, `ops/chefs`.
- [x] Smoke `scripts/smoke-chef-a.mjs`. Full suite 598/598.

## Phase 2 — Chef portal & dish builder [x]
- [x] `chef_dishes` (migration 0019) extends `menu_items`: mode, special requests (customizable only), fulfillment format, portion, ingredients, allergen declaration, prep time, per-dish capacity/lead/cutoff/advance overrides, photos, review status, pending changes.
- [x] Quote lines at chef kitchens carry the branded title, so orders, tickets and receipts read “Gutad’s Pumpkin pie — by Chef Carlos”.
- [x] Approval turns the application’s starter dishes into drafts.
- [x] 5-step builder (describe → fixed/customizable → options → availability → preview & submit) with a live customer preview. Drafts autosave; ingredient tags and photo upload with a cover image.
- [x] Live dishes: price and availability apply immediately; ingredients, allergens, photos, description and mode wait in `pendingChanges` for Gutad review (customers keep seeing the approved version).
- [x] Menu sections with drag-and-drop plus ↑ ↓ buttons (W3C non-drag alternative), move between sections, sold out, archive.
- [x] Gutad dish review (web tab and mobile Ops): new listings and change diffs; approve, send back with a note, suspend, reinstate.
- [x] Public storefront dishes by section, dish page (dish first, chef attribution, format, portion, ingredients, allergens, ordering window, sticky or bottom action). Chef carts are scheduled-only at checkout (web and mobile); slots respect the chef’s notice, with a 21-day window.
- [x] Mobile: chef dishes and editor (camera photos), chef directory, storefront, dish screen, date/time picker in checkout, home banner.
- [x] Smoke `scripts/smoke-chef-b.mjs`. Full suite 631/631.

## Phase 3 — Customization engine [x]
- [x] Shared engine `evaluateCustomization` (`@gutad/shared/customization`), used by the API quote, web and mobile. Selection types SINGLE, LEVEL, MULTI, QUANTITY and INCLUDED; legacy CHOICE groups unchanged. Quantities are sent as repeated option ids, so carts, quotes and orders keep their shape.
- [x] Defaults, min/max, per-option max quantity, conditional groups (“only when”), per-context rules (price, max or unavailable when another option is chosen), locked components, sold-out options.
- [x] Allergen and dietary effects. Options add allergens; adding fish/shellfish/milk/egg/wheat/nuts automatically removes the dietary labels they break (shrimp → not vegetarian).
- [x] Migration 0020: modifier group/option columns, `chef_dishes.options_config` and `modifier_group_ids`, `chef_extras`, `chef_dish_extras`, `order_lines.allergens` and `dietary_tags` (purchase snapshot). Kitchen and packing flag ALLERGEN when a customization adds one.
- [x] Chef option builder with templates (portion, protein, spice, sauce, cheese, toppings, leave out, included), an option table, reordering, rules, validation and a “try it as a customer” preview. Approved configs become modifier groups with stable ids. Option changes on live dishes wait for review; option sold-out is immediate.
- [x] Extras catalog (`/chef/extras`): price per portion, synonyms, allergens, per-dish or all-dish allowance. New extras and allergen changes are Gutad-reviewed (web and mobile Ops); approved extras sync into each dish’s searchable extras group.
- [x] Customer UI: dish first, then Customize. Desktop shows options beside a sticky summary; phones get a full-height sheet with a bottom action. Radio cards, segmented levels, checkboxes with prices, −/+ steppers, locked “included”, extras search with an “Ask Chef X” entry (requests in Phase 6), live price, added-allergen and lost-label warnings. Deep link `?customize=1`.
- [x] Mobile: customization on the dish screen; option editing in the chef dish editor (conditions and rules on web); extras approval in Ops.
- [x] Demo: Spaghetti (7 option groups including conditional shrimp style, Large-size topping rule, included components) and celebration cake; 3 approved extras.
- [x] Smoke `scripts/smoke-chef-c.mjs`. Full suite 657/659; the two failures are the older campaign-holdout checks, which are timing-dependent (likely the API rate limit during the busiest stretch).
## Phase 4 — Advance ordering & capacity [x]
- [x] Migration 0021: `chef_calendar_days` (per-date open/close and capacity overrides), `chef_pauses` (holiday ranges), `kitchen_capacity_ledger` (HELD / CONFIRMED / RELEASED units per kitchen location and service date). Existing scheduled chef orders backfilled as confirmed.
- [x] `ChefCalendarService` (global module): a date D can be ordered until (D − notice days) at the cutoff hour, kitchen time. Statuses AVAILABLE, SOLD_OUT, NOT_COOKING, PAUSED, CLOSED, CUTOFF_PASSED, TOO_FAR. 30-minute times from the cooking-day window; same-day orders need an hour.
- [x] Limits: per-dish daily limit (`chef_dishes.daily_capacity`) and kitchen limit (chef daily capacity or the date override), shared across dishes. A cart uses the strictest dish’s notice, cutoff and advance window. Admin cap `chefs.max_advance_days` (default 60).
- [x] Quotes for chef kitchens require a day (`SCHEDULE_REQUIRED`), validate the calendar (`CHEF_CUTOFF_PASSED`, `CHEF_NOT_COOKING`, `CHEF_PAUSED`, `CHEF_TOO_FAR`, `CHEF_TIME_UNAVAILABLE`, `DISH_CAPACITY_FULL`, `KITCHEN_CAPACITY_FULL`) and hold the portions for the quote’s 10 minutes. A new quote with the same `holdKey` (checkout session) replaces its hold. Advisory lock per kitchen and date.
- [x] Checkout confirms the portions inside its transaction and re-checks capacity (409 before payment if the date filled). Canceled or rejected orders stop counting automatically; lapsed holds are released by a 5-minute job.
- [x] Endpoints: `GET public/chef-dishes/:id/availability`, `POST public/chef-kitchens/:locationId/availability` (cart), `GET chef/calendar`, `PUT chef/calendar/settings`, `PUT chef/calendar/days/:date`, `POST/DELETE chef/calendar/pauses`, `GET admin/chefs/:id/calendar`. Closing a day or pausing over existing orders needs `acknowledgeOrders`. The location page’s pickup times for chef kitchens come from the calendar.
- [x] Web: `DateSlotPicker` (month grid with arrow-key navigation, “N left”, reasons for unavailable dates, order-by time, time chips) on the dish page (next available date; the chosen day carries to checkout) and at checkout (cart calendar, holdKey, capacity errors refresh the calendar). `/chef/calendar` (weekly settings, per-date changes, booked/held per day and dish, time away). Admin chef calendar view.
- [x] Mobile: `DateSlotPicker`, checkout, dish screen availability, `chef/calendar`, dashboard link.
- [x] Smoke `scripts/smoke-chef-d.mjs` (50 checks). Full suite 709/709.
## Phase 5 — Checkout, payments & multi-chef [x]
- [x] Migration 0022: `checkout_groups`, `order_payment_allocations` (one payment split across orders, refunds tracked per order), and order columns `checkout_group_id`, `prepaid`, `accept_by`, `free_cancel_until`, `late_refund_pct`, `recognized_at`.
- [x] Charge now: chef orders are captured in full at checkout (platform charge, never a destination charge). The ledger holds the money in `DEFERRED_REVENUE` per order. Completion (pickup, delivery or no-show, plus a 1-minute catch-up job) moves it to `MERCHANT_PAYABLE` (food + tax − commission), Gutad commission and fees, so weekly settlement only pays completed orders.
- [x] Acceptance: `accept_by` = min(now + `chefs.policy.acceptHours`, order time − 2 h), at least 30 minutes. A chef decline or a missed deadline declines the order and refunds it in full automatically (job every minute), restoring credits and points.
- [x] Cancellation by cutoff: full refund before the date’s order cutoff (or while the chef hasn’t accepted); afterwards the chef’s `lateRefundPct` (chef setting within Gutad’s range). The kept part is credited to the chef. `GET orders/:id/cancellation` previews the refund. Staff cancels refund from the right allocation.
- [x] Fee scope `fees.chef_network` (approval-gated): commission 15% and Chef Network customer fees (service 8%, $1.99–$7.99, small order under $15 = $2.99). Policy `chefs.policy` (accept hours, late-refund min/max/default). Admin “Fees & policy” tab.
- [x] Multi-chef: `POST /checkout-groups` (1–6 chef quotes, each with its own day, time and capacity hold) places one child order per kitchen and charges once, all in one transaction. `GET /checkout-groups/:id` (owner, staff, or guest by email).
- [x] Branding: line titles already read “Gutad’s X — by Chef Y”. Order pages, emails and receipts now say who prepared it, that Gutad sold it, the confirmation deadline and the cancellation terms. Order emails for chef orders cover charged-now, declined-and-refunded and cancellation refunds.
- [x] Web: `/checkout/chefs` (a calendar, quote and hold per chef; one payment), a “check out all chefs together” banner, chef terms at checkout, `/orders/group/[id]`, cancellation preview with confirmation, late-refund setting in `/chef/calendar`.
- [x] Mobile: `checkout-chefs`, `checkout-group/[id]`, checkout banner and terms, order screen cancellation preview.
- [x] Second demo chef: Chef Amara (amara@demo.gutad.io), 2 dishes, Wed–Sun, 50% late refund.
- [x] Smoke `scripts/smoke-chef-e.mjs` (27 checks). Full suite 736/736.
## Phase 6 — Special requests & quotes [x]
- [x] Migration 0023: `chef_requests` (type, details, ingredient, servings, day, reason incl. allergy, budget, alternatives, base customization, status, `respond_by`, first-response time), `chef_request_quotes` (versioned: exact changes, portion, price per serving, quantity, allergens, dietary labels, day and optional time, validity, kind QUOTE/ALTERNATIVE), `chef_request_messages`.
- [x] Flow: customer request → chef Accept & quote / Suggest alternative (own dish) / Ask a question / Decline → customer Accept & pay / Ask for changes (new version) / Withdraw. A customer reply to a question returns it to the chef. Statuses PENDING, NEEDS_INFO, QUOTED, ACCEPTED, ORDERED, DECLINED, WITHDRAWN, EXPIRED, CLOSED.
- [x] Requests only for dishes that take them and days the chef cooks; quotes only for open days at that quantity; a quote never outlives the day's order cutoff. Setting `chefs.requests` (chef 24 h, quote 48 h, customer 72 h, 5 open per customer), editable in Admin → Chef Network → Fees & policy.
- [x] Checkout: an accepted quote is a cart line (`chefRequestQuoteId`) priced from the quote, with quantity and day (and time) fixed, only for its customer; normal checkout re-checks capacity and holds it; the line carries the changes (“Special request R-…”) and allergens to the kitchen; used once (`CHEF_QUOTE_USED`), and the request becomes ORDERED with its order.
- [x] Job every 5 minutes (`POST admin/jobs/chef-requests` to run it): expires unanswered requests and questions, and quotes not accepted or paid in time. Outbox events `chef_request.*`; emails/in-app `chef.request.*` (new, quoted, question, message, revision, accepted, declined, withdrawn, expired, closed).
- [x] Staff supervision: `GET admin/chef-requests` (open, waiting on chefs, due within 4 h, average first response, quote-to-order rate, expired), extend deadlines, close with a reason.
- [x] Web: dish page “Request something special” and the customizer’s “Ask Chef X to add …”; request form; `/account/requests/[id]` and the account “Special requests” tab; chef `/chef/requests` inbox and detail with the four actions; dashboard banner; `/admin/chefs/requests`; checkout locks quoted lines and points to the quoted day.
- [x] Mobile: `requests/new`, `requests/index`, `requests/[id]` (customer and staff), `chef/requests`, `chef/request/[id]`, `ops/chef-requests`, dish screen entry points, checkout support.
- [x] Smoke `scripts/smoke-chef-f.mjs` (37 checks). Full suite 773/773.
## Phase 7 — Admin operations & analytics [x]
- [x] Migration 0024: `chef_quality_events` (automatic and staff actions, one automatic action per incident), `chef_profiles.status_cause` (DOCUMENTS, QUALITY, ADMIN), `chef_requests.reminded_at` / `escalated_at`.
- [x] Kitchens and documents: hourly job expires chef documents, reminds chefs 30 and 7 days before expiry, pauses a chef whose required document expired (cause DOCUMENTS), and reinstates them once the renewal is approved (the chef then reopens availability). Renewals use the existing upload; staff approve or reject them from Admin → Chef Network → Kitchens & documents.
- [x] Quality: per-chef metrics over a window (orders, declined and unconfirmed, cancellations, incidents excluding reversed responsibility, food safety, ratings, request response). A food-safety report on a chef order suspends the dish (or pauses the chef when the dish is unknown), once per report. Chefs over the incident or decline limits are flagged at most weekly (record + ops alert). Staff actions: warning, probation, internal note, dish suspend/reinstate, chef pause/suspend/reinstate, recorded and sent to the chef (notes stay internal). Setting `chefs.quality`.
- [x] Earnings: `GET chef/earnings` and `GET admin/chefs/:id/earnings` (payable, held until completion, per-order food/tax/commission/net, last 30 days, adjustments). Admin adjustments post through `finance/adjustments`; statements and disputes stay in merchant finance.
- [x] Special-request escalation (setting `chefs.requests`): reminder to the chef at 50% of the window, ops alert 4 hours before the deadline (high severity for allergies), resolved when the chef answers, the request closes or Gutad extends it. Escalated filter and count in Admin → Special requests.
- [x] Analytics `GET admin/chef-network/analytics?days=`: activation funnel, orders and gross bookings, Gutad revenue and take rate, declined/unconfirmed/cancelled rates, confirmation time, lead days, requests, repeat customers, daily orders, popular options, top dishes and chefs.
- [x] Web: admin tabs Kitchens & documents and Quality, chef quality & earnings modal with actions and adjustments, `/admin/chefs/analytics`, quality and escalation settings in Fees & policy; chef `/chef/earnings` and `/chef/compliance` (renewal upload, metrics vs limits, record).
- [x] Mobile: `chef/compliance`, `chef/earnings`, `ops/chef-kitchens`, `ops/chef-quality` (+ detail with actions and adjustments), `ops/chef-analytics`; dashboard paused notice.
- [x] Smoke `scripts/smoke-chef-g.mjs` (28 checks). Full suite 801/801.
## Phase 8 — Hardening & docs [x]
- [x] Migration 0025: `orders.amended_from_order_id`.
- [x] Reorder revalidation: `POST /orders/:id/reorder` with `{ mode: 'cart' }` rebuilds cart lines against today's menu (unavailable, sold-out and special-request lines left out with a reason; options that no longer fit fall back to defaults; price changes listed; next open date for chef kitchens). Web and mobile reorder add to the cart.
- [x] Changing a paid chef order before its cutoff: `GET /orders/:id/amendment`, quotes and the calendar accept `replacesOrderId` (the order's own portions don't count, for its customer only), `POST /orders/:id/amend` places and charges the changed order, then cancels and refunds the original in full, in one transaction (idempotent; declined card changes nothing; orders with a special request can't be changed). Email variant “Order N replaces M”. Web `/orders/[id]/change`, mobile `order/change/[id]`.
- [x] Fix: special-request line titles and messages carried cp1252 bytes from an edit script (“�” instead of “·” and “’”); file repaired, all tracked files scanned, smoke check added.
- [x] Docs: `CHEF-NETWORK-PLAN.md` (as built), `ARCHITECTURE.md` (prepaid money flow, lifecycles), `CAPABILITY-MAP.md`, `Pending_Tasks.md` (follow-ups CN.V, CN.1–CN.5), `Completed_Tasks.md`.
- [x] Smoke `scripts/smoke-chef-h.mjs` (19 checks). Full suite 818/820; the 2 misses are the known timing-dependent campaign holdout checks (one of 10 orders hit the API rate limit).

## Follow-ups CN.1–CN.4 [x]
- [x] CN.1 add dishes while changing a paid order (web, mobile; `chefNetwork.chefSlug`).
- [x] CN.2 staff alternatives from other chefs (`GET admin/chef-requests/:id/alternatives`, listed-price guard; web, mobile).
- [x] CN.3 “Describe what you want” (`POST chef-dishes/:id/interpret`; Claude or keyword matching; web, mobile).
- [x] CN.4 optional automatic pause/suspension after N weekly flags (`chefs.quality.autoActionAfterWeeks`, `autoAction`).
- [x] Smoke `scripts/smoke-chef-i.mjs` (21 checks). Full suite 841/841.

## Log
- 2026-11-17 Follow-ups CN.1–CN.4 built and verified locally (841/841 smoke, web build, typecheck of shared, API, web and mobile).
- 2026-11-17 Phase 8 built and verified locally (all Chef Network checks pass; web build; typecheck of shared, API, web and mobile).
- 2026-11-17 Phase 7 built and verified locally (801/801 smoke, web build, typecheck of shared, API, web and mobile).
- 2026-11-17 Phase 6 built and verified locally (773/773 smoke, web build, typecheck of shared, API, web and mobile).
- 2026-11-17 Phase 5 built and verified locally (736/736 smoke, web build, typecheck of shared, API, web and mobile).
- 2026-11-17 Phase 4 built and verified locally (709/709 smoke, web build, typecheck of shared, API, web and mobile).
- 2026-11-17 Phase 3 built and verified locally (web build, API/web/mobile typecheck, smoke incl. 27 new checks).
- 2026-11-16 Phase 2 built and verified locally (631/631 smoke, web build, API/web/mobile typecheck).
- 2026-11-16 Phase 1 built and verified locally (598/598 smoke, web build, typecheck of API, web and mobile).
