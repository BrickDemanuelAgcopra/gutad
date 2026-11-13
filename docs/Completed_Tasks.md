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

