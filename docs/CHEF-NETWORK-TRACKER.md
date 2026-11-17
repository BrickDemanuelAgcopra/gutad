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

## Phase 2 — Chef portal & dish builder [ ]
- [ ] `chef_dishes` extension (mode, format, lead days, capacity, review status) and the `chefDishTitle` snapshot on order lines.
- [ ] 5-step dish builder with live preview; menu sections reordered by drag (with move up/down alternatives).
- [ ] Dish review queue (allergen completeness, portion, photos, price); publish and suspend.
- [ ] Storefront dishes and fixed-dish ordering (web + mobile).

## Phase 3 — Customization engine [ ]
## Phase 4 — Advance ordering & capacity [ ]
## Phase 5 — Checkout, payments & multi-chef [ ]
## Phase 6 — Special requests & quotes [ ]
## Phase 7 — Admin operations & analytics [ ]
## Phase 8 — Hardening & docs [ ]

## Log
- 2026-11-16 Phase 1 built and verified locally (598/598 smoke, web build, typecheck of API, web and mobile).
