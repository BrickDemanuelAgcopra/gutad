/**
 * Users, Roles & Permissions (IAM) contracts shared by the API, web and mobile.
 *
 * Fine-grained permissions are `<resource>:<action>` strings configured per role in the permission matrix.
 * The API's ~200 existing checks use the coarse console keys in `PERMISSIONS` (e.g. `orders.manage`);
 * `coarseFromFine` derives those keys from a role's matrix, and `requiredFineFor` narrows a coarse check to
 * the specific action a request performs (DELETE → delete, export paths → export, refund paths → refund …).
 */
import { PERMISSIONS, ROLE_PERMISSIONS, STAFF_ROLES, type Permission, type StaffRole } from './admin';

export const IAM_ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'refund', 'manage_access'] as const;
export type IamAction = (typeof IAM_ACTIONS)[number];

export const IAM_ACTION_LABELS: Record<IamAction, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
  publish: 'Publish',
  export: 'Export',
  refund: 'Refund',
  manage_access: 'Manage access',
};

export interface IamResource {
  key: string;
  label: string;
  group: 'Modules' | 'Sensitive data';
  description: string;
  actions: IamAction[];
  /** coarse key granted by `view` */
  read?: Permission;
  /** coarse key granted by any change action (create, edit, delete, publish, refund, manage_access, and approve unless `approve` is set) */
  manage?: Permission;
  /** coarse key granted by `approve` (when approval has its own key) */
  approve?: Permission;
}

export const IAM_RESOURCES: IamResource[] = [
  { key: 'overview', label: 'Executive dashboard', group: 'Modules', description: 'Sales, revenue and performance dashboards', actions: ['view', 'export'], read: 'overview.read' },
  { key: 'ops', label: 'Live operations & alerts', group: 'Modules', description: 'Live board, alerts, location pauses', actions: ['view', 'edit', 'export'], read: 'ops.read', manage: 'ops.manage' },
  { key: 'orders', label: 'Orders', group: 'Modules', description: 'Order search, notes, remedies', actions: ['view', 'create', 'edit', 'delete', 'export', 'refund'], read: 'orders.read', manage: 'orders.manage' },
  { key: 'merchants', label: 'Merchants & locations', group: 'Modules', description: 'Onboarding, verification, lifecycle, locations', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'], read: 'merchants.read', manage: 'merchants.manage' },
  { key: 'catalog', label: 'Menus, brands & pricing', group: 'Modules', description: 'Menus, brands, prices, fees and tax', actions: ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export'], read: 'catalog.read', manage: 'catalog.manage' },
  { key: 'culinary', label: 'Recipes & food safety', group: 'Modules', description: 'Recipe releases, allergens, safety records', actions: ['edit', 'approve', 'publish'], manage: 'culinary.manage' },
  { key: 'kitchens', label: 'Kitchens, supply & workforce', group: 'Modules', description: 'Kitchen ops, inventory, purchase orders, equipment, staff schedules', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'], read: 'kitchens.read', manage: 'kitchens.manage' },
  { key: 'delivery', label: 'Delivery & couriers', group: 'Modules', description: 'Dispatch, zones, couriers', actions: ['view', 'create', 'edit', 'delete', 'export'], read: 'delivery.read', manage: 'delivery.manage' },
  { key: 'finance', label: 'Finance & payouts', group: 'Modules', description: 'Payments, settlement, payouts, accounting', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'refund'], read: 'finance.read', manage: 'finance.manage', approve: 'finance.approve' },
  { key: 'support', label: 'Support', group: 'Modules', description: 'Tickets, remedies, credits', actions: ['view', 'create', 'edit', 'export', 'refund'], read: 'support.read', manage: 'support.manage' },
  { key: 'customers', label: 'Customers', group: 'Modules', description: 'Customer directory and 360', actions: ['view', 'export'], read: 'customers.read' },
  { key: 'growth', label: 'Promotions & rewards', group: 'Modules', description: 'Offers, rewards, gift cards, campaigns', actions: ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export'], read: 'growth.read', manage: 'growth.manage' },
  { key: 'approvals', label: 'Approval queue', group: 'Modules', description: 'Decide approval requests (also needs the request kind’s permission)', actions: ['approve'], approve: 'approvals.decide' },
  { key: 'security', label: 'Users, roles & audit', group: 'Modules', description: 'Staff, roles, permissions, sessions, audit history', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'manage_access'], read: 'security.read', manage: 'security.manage' },
  { key: 'settings', label: 'Platform settings', group: 'Modules', description: 'Thresholds, SSO, policies', actions: ['edit'], manage: 'settings.manage' },
  { key: 'integrations', label: 'Integrations & API access', group: 'Modules', description: 'Providers, webhooks, devices, service accounts', actions: ['view', 'edit', 'manage_access'], read: 'integrations.manage', manage: 'integrations.manage' },
  { key: 'chefs', label: 'Chef Network', group: 'Modules', description: 'Chef applications, kitchens, dishes and special requests', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'], read: 'chefs.read', manage: 'chefs.manage' },
  { key: 'field.pii', label: 'Personal information', group: 'Sensitive data', description: 'Customer and staff contact details', actions: ['view', 'export'], read: 'customers.pii' },
  { key: 'field.bank', label: 'Bank & payout details', group: 'Sensitive data', description: 'Beneficiary, account digits, tax ids', actions: ['view', 'export'] },
  { key: 'field.salary', label: 'Pay rates & payroll', group: 'Sensitive data', description: 'Wage rates, gross pay, payroll exports', actions: ['view', 'export'] },
  { key: 'field.financials', label: 'Financial reports', group: 'Sensitive data', description: 'P&L, costs, cash forecast, budgets, receivables and payables', actions: ['view', 'export'] },
];

export const IAM_RESOURCE_MAP: Record<string, IamResource> = Object.fromEntries(IAM_RESOURCES.map((r) => [r.key, r]));
export const ALL_FINE_PERMISSIONS: string[] = IAM_RESOURCES.flatMap((r) => r.actions.map((a) => `${r.key}:${a}`));
export const isFinePermission = (p: string) => ALL_FINE_PERMISSIONS.includes(p);

const CHANGE_ACTIONS: IamAction[] = ['create', 'edit', 'delete', 'publish', 'refund', 'manage_access'];

/** Console keys a set of matrix permissions grants. */
export function coarseFromFine(fine: readonly string[]): Permission[] {
  const set = new Set(fine);
  const out = new Set<Permission>();
  for (const r of IAM_RESOURCES) {
    const has = (a: IamAction) => set.has(`${r.key}:${a}`);
    if (r.read && has('view')) out.add(r.read);
    if (r.manage && (CHANGE_ACTIONS.some(has) || (!r.approve && has('approve')))) out.add(r.manage);
    if (r.approve && has('approve')) out.add(r.approve);
  }
  return [...out];
}

/** Matrix permissions equivalent to a list of console keys (used to seed the system roles with today's access). */
export function fineFromCoarse(coarse: readonly string[]): string[] {
  const out = new Set<string>();
  for (const r of IAM_RESOURCES) {
    const add = (a: IamAction) => r.actions.includes(a) && out.add(`${r.key}:${a}`);
    if (r.read && coarse.includes(r.read)) {
      add('view');
      add('export');
    }
    if (r.manage && coarse.includes(r.manage)) {
      for (const a of CHANGE_ACTIONS) add(a);
      if (!r.approve) add('approve');
      add('view');
    }
    if (r.approve && coarse.includes(r.approve)) add('approve');
  }
  return [...out];
}

/** Default sensitive-data access for the built-in roles (who saw these fields before field permissions existed). */
export const DEFAULT_FIELD_ACCESS: Record<string, StaffRole[]> = {
  'field.bank': ['PLATFORM_ADMIN', 'FINANCE', 'EXECUTIVE'],
  'field.salary': ['PLATFORM_ADMIN', 'FINANCE', 'EXECUTIVE', 'OPERATIONS', 'CULINARY', 'IT'],
  'field.financials': ['PLATFORM_ADMIN', 'FINANCE', 'EXECUTIVE'],
};

/** Matrix of a built-in role as seeded (today's access plus default sensitive-data access). */
export function systemRolePermissions(role: StaffRole): string[] {
  if (role === 'PLATFORM_ADMIN') return [...ALL_FINE_PERMISSIONS];
  const out = new Set(fineFromCoarse(ROLE_PERMISSIONS[role]));
  for (const [field, roles] of Object.entries(DEFAULT_FIELD_ACCESS)) if (roles.includes(role)) { out.add(`${field}:view`); out.add(`${field}:export`); }
  return [...out];
}

/**
 * Narrowing: the fine permission a request needs on top of a coarse key, judged from its method and path.
 * Returns null when the coarse key alone decides. Arrays mean "any of".
 */
export function requiredFineFor(coarse: string, method: string, path: string): string[] | null {
  const res = IAM_RESOURCES.find((r) => r.read === coarse || r.manage === coarse || r.approve === coarse);
  if (!res) return null;
  const p = path.toLowerCase().split('?')[0];
  const supports = (a: IamAction) => res.actions.includes(a);
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') {
    if (/\.csv$|\/export(\b|\/|$)|\/download(\b|\/|$)/.test(p) && supports('export')) return [`${res.key}:export`];
    return null;
  }
  if (coarse !== res.manage) return null;
  if (/\/refunds?(\/|$)/.test(p) && supports('refund')) return [`${res.key}:refund`];
  if (/\/(publish|rollback|unpublish)(\/|$)/.test(p) && supports('publish')) return [`${res.key}:publish`];
  if (/\/(approve|verify|reject)(\/|$)/.test(p) && supports('approve')) return [`${res.key}:approve`];
  if (m === 'DELETE' && supports('delete')) return [`${res.key}:delete`];
  if (m === 'PUT' || m === 'PATCH') return supports('edit') ? [`${res.key}:edit`] : null;
  const change = (['create', 'edit', 'manage_access'] as IamAction[]).filter(supports).map((a) => `${res.key}:${a}`);
  return change.length ? change : null;
}

/** Field rules: paths that need a sensitive-data permission for staff (merchant members are judged by their org role). */
export const FIELD_PATH_RULES: { field: string; action: 'view' | 'export'; pattern: RegExp }[] = [
  { field: 'field.salary', action: 'export', pattern: /\/payroll\.csv$/ },
  { field: 'field.financials', action: 'view', pattern: /^\/accounting\/(pnl|costs|cash-forecast|budgets|receivables|payables|deferred-revenue|credit-liability)(\/|$)/ },
  { field: 'field.financials', action: 'export', pattern: /^\/accounting\/(journal\.csv|audit-export)(\/|$)/ },
  { field: 'field.bank', action: 'export', pattern: /statement-lines\.csv$/ },
];

/** Response keys masked for staff without the field permission. */
export const MASKED_FIELDS: Record<string, string[]> = {
  'field.bank': ['bankLast4', 'beneficiaryName', 'taxId', 'accountNumber', 'routingNumber', 'iban', 'swift', 'bic', 'payoutAccountRef'],
  'field.salary': ['rateCents', 'grossCents', 'hourlyRateCents', 'wageCents', 'payRateCents', 'salaryCents'],
};

/** Approval authority: the most a role may approve per request kind (cents). No entry = no cap. */
export const APPROVAL_LIMIT_KINDS = {
  REFUND: 'Refunds',
  DISCOUNT: 'Discounts & credits',
  PURCHASE_ORDER: 'Purchase orders',
  PAYOUT_RELEASE: 'Payouts',
  SELF_REFUND: 'Refunds without approval',
} as const;
export type ApprovalLimitKind = keyof typeof APPROVAL_LIMIT_KINDS;

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED', 'ARCHIVED'] as const;
export type StaffStatus = (typeof USER_STATUSES)[number];
/** Statuses that block sign-in and API access. */
export const BLOCKED_STATUSES = ['DISABLED', 'SUSPENDED', 'ARCHIVED'];

export const ASSIGNMENT_KINDS = ['STANDARD', 'TEMPORARY', 'ACTING', 'EMERGENCY'] as const;
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

/** Permissions whose grant counts as a privilege increase (security notifications, dual control). */
export const PRIVILEGED_PERMISSIONS = ['security:edit', 'security:create', 'security:delete', 'security:manage_access', 'security:approve', 'settings:edit', 'finance:approve', 'integrations:manage_access', 'field.bank:view', 'field.bank:export'];
export const isPrivileged = (perms: readonly string[]) => perms.some((p) => PRIVILEGED_PERMISSIONS.includes(p));

export const SECURITY_ALERT_TYPES = {
  PRIVILEGE_INCREASE: 'Privilege increase',
  NEW_SUPERADMIN: 'New superadmin',
  SUSPICIOUS_LOGIN: 'Suspicious sign-in',
  ACCOUNT_LOCKED: 'Account locked',
  SENSITIVE_CHANGE: 'Sensitive access change',
  API_KEY: 'API access change',
  KEY_EXPIRING: 'API key expiring',
  INACTIVE_ACCOUNT: 'Inactive account',
  OFFBOARDING: 'Offboarding',
  EMERGENCY_ACCESS: 'Emergency access',
} as const;
export type SecurityAlertType = keyof typeof SECURITY_ALERT_TYPES;

export interface AccessPolicy {
  /** user ids allowed to grant superadmin; empty = any active superadmin */
  superadminGranters: string[];
  /** critical changes (superadmin grants, privileged role edits) need a second superadmin when one exists */
  requireSecondApprover: boolean;
  /** failed password attempts before an account locks */
  maxLoginAttempts: number;
  lockMinutes: number;
  /** failed attempts from one IP (any account) before that IP is throttled */
  ipMaxAttempts: number;
  /** staff with no sign-in for this many days are flagged inactive */
  inactiveDays: number;
  /** suspend inactive staff automatically (0 = never) */
  autoSuspendInactiveDays: number;
  /** a new access review campaign opens this often (0 = manual only) */
  reviewIntervalDays: number;
  /** longest API key lifetime */
  apiKeyMaxDays: number;
  /** invitation link lifetime */
  inviteDays: number;
}

export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  superadminGranters: [],
  requireSecondApprover: true,
  maxLoginAttempts: 5,
  lockMinutes: 15,
  ipMaxAttempts: 50,
  inactiveDays: 45,
  autoSuspendInactiveDays: 0,
  reviewIntervalDays: 90,
  apiKeyMaxDays: 365,
  inviteDays: 7,
};

export const SYSTEM_ROLE_DESCRIPTIONS: Record<StaffRole, string> = {
  PLATFORM_ADMIN: 'Superadmin: every permission. Cannot be edited.',
  EXECUTIVE: 'Read everything, approve payouts and decisions.',
  OPERATIONS: 'Run live operations, merchants, kitchens and delivery.',
  FINANCE: 'Payments, settlement, payouts and accounting.',
  CULINARY: 'Menus, recipes and food safety.',
  SUPPORT: 'Customer support, refunds within limits.',
  MARKETING: 'Promotions, rewards and campaigns.',
  IT: 'Users, roles, security settings and integrations.',
  DISPATCHER: 'Delivery dispatch.',
};

export const SYSTEM_ROLE_KEYS: readonly string[] = STAFF_ROLES;

/** Explanation of one permission for one person (effective-access preview). */
export interface AccessExplanation {
  permission: string;
  allowed: boolean;
  grantedBy: string[];
  reasons: string[];
}

/** Coarse console permission of a fine one's resource, for sensitivity capping. */
export function sensitivityOf(fine: string) {
  const [res] = fine.split(':');
  const r = IAM_RESOURCE_MAP[res];
  const k = r?.manage || r?.read || r?.approve;
  return k ? PERMISSIONS[k].sensitivity : 'RESTRICTED';
}
