# Users, Roles & Permissions (IAM): plan

Superadmin module **Users, roles & permissions** (`/admin/iam` on web, Ops → **Users & access** on mobile). It extends the Phase A foundation (staff roles, scopes, sessions, MFA, SSO, emergency and support access, approvals, audit) into full identity and access management. Started and shipped 2026-11-14.

## Gap analysis (starting point)

| # | Area | Before | Now |
|---|---|---|---|
| 1 | User management | Grant roles to an existing account; disable/enable | Create and invite staff, profile (title, department, team, manager, employee id), activate, suspend (optionally until a date), deactivate, archive, resend/revoke invitation, bulk CSV import with dry run, CSV export |
| 2 | Role management | 9 hard-coded roles | Database roles: 9 built-in (SYSTEM) + custom; create, edit description, duplicate, archive unused, restore; several roles per person |
| 3 | Permission management | 28 coarse keys | 20 resources × up to 9 actions (view, create, edit, delete, approve, publish, export, refund, manage access) |
| 4 | Permission matrix | — | Roles × resource/action checkbox grid, saved in one batch with step-up |
| 5 | Access scope | Regions, organizations, locations, sensitivity ceiling | + parent companies, kitchens, brands, teams |
| 6 | Role assignment | Replace roles (sign-out required) | Assign/remove, primary role + responsibility, scheduled start, end date, bulk assignment; applies immediately |
| 7 | Data-level restrictions | Customer PII only | Sensitive-data permissions: personal info, bank & payout details, pay rates & payroll, financial reports; export is its own action everywhere |
| 8 | Approval authority | Refund threshold per built-in role | Per-role limits: refunds, discounts/credits, purchase orders, payouts, refunds-without-approval |
| 9 | Separation of duties | Requester ≠ approver | + no self-assignment, no self-review, no self-status change, no granting permissions you don't hold, second superadmin for critical changes |
| 10 | Login security | SSO, TOTP MFA, recovery | + failed-attempt lockout per account and per IP, sign-in log, admin unlock |
| 11 | Sessions | Per-person list and revoke | All staff sessions, force sign-out, sign out all staff, inactivity timeout enforced on every request |
| 12 | Temporary access | Emergency break-glass | + time-limited roles, acting-manager cover, auto-expiry |
| 13 | Access requests | — | Request a role with justification and duration; approve/reject; status tracking; expiry |
| 14 | Audit | Reasons, request and grant ids | + `iam.*` actions for invitations, roles, permissions, assignments, scope, requests, reviews, keys; sign-in events |
| 15 | Access reviews | — | Review campaigns with flags (inactive, never signed in, no MFA, privileged, superadmin, temporary); keep/revoke/suspend; automatic every N days; inactive-account flags and optional auto-suspend |
| 16 | Offboarding | Disable | One step: disable, end sessions, grants, roles, invitations and requests; hand pending approvals, tickets, alerts, pipeline, accounts and service accounts to someone else |
| 17 | Effective access | — | Per-cell grant/deny with the roles that grant it and the reasons it is denied; "explain" for one permission in one organization/location |
| 18 | Superadmin safeguards | Only admins grant admin | Granter allowlist, last-active-superadmin lock, step-up (TOTP or password), dual control, superadmin role immutable |
| 19 | Service accounts & API keys | — | Integration identities with their own permissions and organization scope, IP allowlist, keys that must expire, rotation with a grace period, revocation |
| 20 | Security notifications | Emergency-access email | Alert feed + email/push for privilege increases, new superadmins, suspicious sign-ins (new network), lockouts, sensitive changes, API access changes, expiring keys, inactive accounts, offboarding |

## Architecture

1. **Live access record (ACL).** `AclService` (core) combines active assignments (time windows), built-in roles still on the user row, active emergency grants, scope, MFA policy and status into one record, cached in Redis (`acl:<ver>:<user>`) until the next scheduled start/expiry or 60 s. The auth guard attaches it to every request, so role, permission, scope, status and expiry changes apply immediately without signing anyone out. Any role change bumps `acl:ver`.
2. **Fine permissions, coarse checks.** Roles hold `resource:action` strings. The ~200 existing `assertCan('orders.manage')` calls stay: `coarseFromFine` derives the console keys, and `can()` narrows each coarse check to the action the request performs (`requiredFineFor`: DELETE → delete, `.csv`/`/export`/`/download` → export, `/refund` → refund, `/publish|rollback` → publish, `/approve|verify|reject` → approve, PUT/PATCH → edit, POST → create/edit). Built-in roles are seeded with exactly the console permissions they had (verified for all 9).
3. **Built-in roles stay on `users.roles`.** Code that checks roles directly keeps working: assignments of built-in roles are mirrored onto the user row (`syncUserRoles`), and the guard replaces the token's staff roles with the live ones.
4. **Data restrictions.** `FieldMaskInterceptor` nulls bank and pay-rate keys in responses for staff without `field.bank:view` / `field.salary:view`; `FIELD_PATH_RULES` gate financial reports, journal/audit exports, payroll CSV and statement exports.
5. **Critical changes** (superadmin grant/removal, role permission/limit/MFA edits, matrix saves, policy, status of a superadmin, offboarding a superadmin, sign out all staff) require step-up: a current TOTP code when MFA is on, otherwise the password. With `requireSecondApprover` on and another active superadmin present, superadmin grants and privileged permission additions become `ACCESS_CHANGE` approvals that only another superadmin can approve.
6. **Service accounts** act through a shadow user (so audit and ownership columns work). Bearer `gsk_…` keys are hashed (sha256), cached for 60 s, checked for expiry and IP allowlist on every call, and can never hold `security:*`.
7. **Worker:** every minute, scheduled roles start, temporary roles end, suspensions lift and requests expire. Every hour: inactive-staff flags (and optional auto-suspend), expiring-key alerts, and the periodic access-review campaign.

Migration `0017_iam.sql`: `access_roles`, `role_assignments`, `staff_profiles`, `staff_invitations`, `access_requests`, `access_reviews`, `access_review_items`, `login_events`, `service_accounts`, `api_keys`, `security_alerts`; `staff_scopes` gains company, kitchen, brand and team columns. On startup the API seeds the built-in roles and creates assignments for everyone holding a built-in role (idempotent).

## Honest scope

- **SSO** remains OIDC for staff (configured under Emergency access & sign-in policy). There is no SCIM provisioning.
- **MFA** is TOTP plus recovery codes. There are no WebAuthn or SMS codes.
- **Team scope** is stored and shown, and it feeds the effective-access preview. Queue filtering by team still follows each module's existing rules.
- **Individual records**: scope works at the level of company, organization, brand, kitchen, location and region. Single orders or tickets are not handed out one by one.
- **Create vs edit**: a POST is accepted with either `create` or `edit`, because the API uses POST for both new records and actions.
- **Suspicious sign-in** means a staff sign-in from an IP not seen for that account in 30 days. There is no geo-IP or impossible-travel check.

## Verification (2026-11-14)

- `npm run typecheck` (shared, api, web, mobile) and `npm run build:api`, `npm run build -w apps/web` all pass.
- `npm run smoke` on a fresh database: **548/548**. That is the 481 existing checks plus 67 new IAM checks in `scripts/smoke-iam.mjs`. The harness turns dual control off at the start, because reruns leave several superadmins, and the IAM section switches it back on to test it.
- Migrated a copy of an older dev database: all 9 existing staff were backfilled (11 assignments). Admin and legacy Support users signed in with exactly their previous permissions.
