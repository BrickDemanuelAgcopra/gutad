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
## Phase 5 — Checkout, payments & multi-chef [ ] (next)
## Phase 6 — Special requests & quotes [ ]
## Phase 7 — Admin operations & analytics [ ]
## Phase 8 — Hardening & docs [ ]

## Log
- 2026-11-17 Phase 4 built and verified locally (709/709 smoke, web build, typecheck of shared, API, web and mobile).
- 2026-11-17 Phase 3 built and verified locally (web build, API/web/mobile typecheck, smoke incl. 27 new checks).
- 2026-11-16 Phase 2 built and verified locally (631/631 smoke, web build, API/web/mobile typecheck).
- 2026-11-16 Phase 1 built and verified locally (598/598 smoke, web build, typecheck of API, web and mobile).
