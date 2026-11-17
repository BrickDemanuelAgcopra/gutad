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

## Phase 3 — Customization engine [ ] (next)
## Phase 4 — Advance ordering & capacity [ ]
## Phase 5 — Checkout, payments & multi-chef [ ]
## Phase 6 — Special requests & quotes [ ]
## Phase 7 — Admin operations & analytics [ ]
## Phase 8 — Hardening & docs [ ]

## Log
- 2026-11-16 Phase 2 built and verified locally (631/631 smoke, web build, API/web/mobile typecheck).
- 2026-11-16 Phase 1 built and verified locally (598/598 smoke, web build, typecheck of API, web and mobile).
