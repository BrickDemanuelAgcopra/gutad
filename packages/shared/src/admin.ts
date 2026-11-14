/**
 * Admin console contracts shared by the API, web and mobile:
 * staff roles → permissions, data sensitivity, and the module registry that drives
 * both the web `/admin` navigation and the mobile Ops workspace.
 */
import type { Role } from './enums';

export const STAFF_ROLES = ['PLATFORM_ADMIN', 'EXECUTIVE', 'OPERATIONS', 'FINANCE', 'CULINARY', 'SUPPORT', 'MARKETING', 'IT', 'DISPATCHER'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  PLATFORM_ADMIN: 'Platform admin',
  EXECUTIVE: 'Executive',
  OPERATIONS: 'Operations',
  FINANCE: 'Finance',
  CULINARY: 'Culinary',
  SUPPORT: 'Support',
  MARKETING: 'Marketing',
  IT: 'IT & security',
  DISPATCHER: 'Dispatch',
};

/** Data sensitivity, lowest to highest. A staff scope sets the highest level a person may see. */
export const SENSITIVITY = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];

export const PERMISSIONS = {
  'overview.read': { label: 'Executive dashboard', sensitivity: 'CONFIDENTIAL' },
  'ops.read': { label: 'View live operations', sensitivity: 'INTERNAL' },
  'ops.manage': { label: 'Pause locations, handle alerts', sensitivity: 'INTERNAL' },
  'orders.read': { label: 'View orders', sensitivity: 'INTERNAL' },
  'orders.manage': { label: 'Act on orders', sensitivity: 'INTERNAL' },
  'merchants.read': { label: 'View merchants', sensitivity: 'INTERNAL' },
  'merchants.manage': { label: 'Onboard and manage merchants', sensitivity: 'CONFIDENTIAL' },
  'catalog.read': { label: 'View menus and brands', sensitivity: 'INTERNAL' },
  'catalog.manage': { label: 'Edit menus, brands, pricing', sensitivity: 'INTERNAL' },
  'culinary.manage': { label: 'Recipes and food safety', sensitivity: 'INTERNAL' },
  'kitchens.read': { label: 'View kitchens', sensitivity: 'INTERNAL' },
  'kitchens.manage': { label: 'Run kitchens, inventory, equipment', sensitivity: 'INTERNAL' },
  'delivery.read': { label: 'View delivery', sensitivity: 'INTERNAL' },
  'delivery.manage': { label: 'Dispatch, zones, couriers', sensitivity: 'CONFIDENTIAL' },
  'finance.read': { label: 'View finance', sensitivity: 'CONFIDENTIAL' },
  'finance.manage': { label: 'Settlement, payouts, accounting', sensitivity: 'CONFIDENTIAL' },
  'finance.approve': { label: 'Approve payouts and bank changes', sensitivity: 'RESTRICTED' },
  'support.read': { label: 'View support tickets', sensitivity: 'INTERNAL' },
  'support.manage': { label: 'Resolve tickets, refunds, credits', sensitivity: 'CONFIDENTIAL' },
  'customers.read': { label: 'View customers', sensitivity: 'CONFIDENTIAL' },
  'customers.pii': { label: 'See customer contact details', sensitivity: 'RESTRICTED' },
  'growth.read': { label: 'View promotions and campaigns', sensitivity: 'INTERNAL' },
  'growth.manage': { label: 'Run promotions, rewards, gift cards', sensitivity: 'CONFIDENTIAL' },
  'approvals.decide': { label: 'Decide approval requests', sensitivity: 'CONFIDENTIAL' },
  'security.read': { label: 'View access and audit', sensitivity: 'RESTRICTED' },
  'security.manage': { label: 'Manage staff access', sensitivity: 'RESTRICTED' },
  'settings.manage': { label: 'Platform settings', sensitivity: 'RESTRICTED' },
  'integrations.manage': { label: 'Integrations and devices', sensitivity: 'CONFIDENTIAL' },
} as const satisfies Record<string, { label: string; sensitivity: Sensitivity }>;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const READS: Permission[] = ['overview.read', 'ops.read', 'orders.read', 'merchants.read', 'catalog.read', 'kitchens.read', 'delivery.read', 'finance.read', 'support.read', 'customers.read', 'growth.read', 'security.read'];

export const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  PLATFORM_ADMIN: ALL_PERMISSIONS,
  EXECUTIVE: [...READS, 'approvals.decide', 'finance.approve'],
  OPERATIONS: ['overview.read', 'ops.read', 'ops.manage', 'orders.read', 'orders.manage', 'merchants.read', 'merchants.manage', 'catalog.read', 'kitchens.read', 'kitchens.manage', 'delivery.read', 'delivery.manage', 'support.read', 'customers.read', 'approvals.decide'],
  FINANCE: ['overview.read', 'finance.read', 'finance.manage', 'finance.approve', 'orders.read', 'merchants.read', 'customers.read', 'support.read', 'approvals.decide'],
  CULINARY: ['ops.read', 'catalog.read', 'catalog.manage', 'culinary.manage', 'kitchens.read', 'kitchens.manage', 'merchants.read', 'orders.read'],
  SUPPORT: ['ops.read', 'orders.read', 'orders.manage', 'support.read', 'support.manage', 'customers.read', 'customers.pii', 'merchants.read', 'delivery.read', 'catalog.read'],
  MARKETING: ['overview.read', 'growth.read', 'growth.manage', 'customers.read', 'merchants.read', 'catalog.read'],
  IT: ['ops.read', 'security.read', 'security.manage', 'settings.manage', 'integrations.manage', 'kitchens.read'],
  DISPATCHER: ['ops.read', 'delivery.read', 'delivery.manage', 'orders.read'],
};

export function isStaffRole(r: string): r is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(r);
}

/** Permissions a set of roles grants, optionally capped by a sensitivity ceiling. */
export function permissionsFor(roles: readonly string[], ceiling: Sensitivity = 'RESTRICTED'): Permission[] {
  const max = SENSITIVITY.indexOf(ceiling);
  const out = new Set<Permission>();
  for (const r of roles) if (isStaffRole(r)) for (const p of ROLE_PERMISSIONS[r]) if (SENSITIVITY.indexOf(PERMISSIONS[p].sensitivity) <= max) out.add(p);
  return [...out];
}

export const ADMIN_GROUPS = ['Overview', 'Operations', 'Merchants', 'Kitchens', 'Delivery', 'Finance', 'Support', 'Growth', 'Security'] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

export interface AdminModule {
  key: string;
  group: AdminGroup;
  label: string;
  description: string;
  permission: Permission;
  /** web route under the admin console */
  web: string;
  /** expo-router path of the mobile Ops screen */
  mobile?: string;
}

/**
 * Module registry. Web `/admin` and the mobile Ops home build their navigation from this list,
 * filtered by the signed-in person's permissions.
 */
export const ADMIN_MODULES: AdminModule[] = [
  { key: 'executive', group: 'Overview', label: 'Executive dashboard', description: 'Sales, revenue, payables, margin and performance by region, merchant, brand and channel', permission: 'overview.read', web: '/admin', mobile: '/ops/executive' },
  { key: 'live', group: 'Operations', label: 'Live operations', description: 'Orders by stage, overdue orders, kitchen capacity, couriers, stockouts and outages', permission: 'ops.read', web: '/admin/live', mobile: '/ops/live' },
  { key: 'alerts', group: 'Operations', label: 'Alerts', description: 'Owned alerts with escalation deadlines and history', permission: 'ops.read', web: '/admin/alerts', mobile: '/ops/alerts' },
  { key: 'orders', group: 'Operations', label: 'Orders', description: 'Search every order; timeline, payments, kitchen, delivery, notes and remedies', permission: 'orders.read', web: '/admin/orders', mobile: '/ops/orders' },
  { key: 'merchants', group: 'Merchants', label: 'Merchants & verification', description: 'Tenants, verification queues, documents and contracts', permission: 'merchants.read', web: '/admin/merchants', mobile: '/ops/merchants' },
  { key: 'pipeline', group: 'Merchants', label: 'Pipeline & onboarding', description: 'Applications, sales pipeline, onboarding progress and account managers', permission: 'merchants.read', web: '/admin/pipeline' },
  { key: 'locations', group: 'Operations', label: 'Locations', description: 'Hours, closures, channels, stations, launch checklist, emergency pause and restart', permission: 'merchants.read', web: '/admin/locations', mobile: '/ops/locations' },
  { key: 'availability', group: 'Operations', label: 'Availability', description: 'Sold-out items, paused stores and stations down across merchants', permission: 'ops.read', web: '/admin/availability' },
  { key: 'changes', group: 'Merchants', label: 'Change requests', description: 'Merchant menu and business-information changes waiting for review', permission: 'merchants.read', web: '/admin/changes' },
  { key: 'performance', group: 'Merchants', label: 'Merchant performance', description: 'Acceptance, cancellations, prep time, lateness and errors by location', permission: 'merchants.read', web: '/admin/performance' },
  { key: 'brands', group: 'Merchants', label: 'Brands & partners', description: 'Ownership, rights, territories, channels, royalties, assets, reviews and statements', permission: 'catalog.read', web: '/admin/brands', mobile: '/ops/brands' },
  { key: 'approvals', group: 'Overview', label: 'Approvals', description: 'Refunds, bank changes, payouts and settings waiting for a decision', permission: 'approvals.decide', web: '/admin/approvals', mobile: '/ops/approvals' },
  { key: 'plans', group: 'Merchants', label: 'Plans & pricing', description: 'Plan catalog, add-ons, subscriptions, promotions, revenue', permission: 'finance.read', web: '/admin/plans' },
  { key: 'finance', group: 'Finance', label: 'Settlement', description: 'Close periods, payouts, reconciliation', permission: 'finance.read', web: '/admin/finance' },
  { key: 'support', group: 'Support', label: 'Support queue', description: 'Incidents, remedies and policy strikes', permission: 'support.read', web: '/admin/support' },
  { key: 'integrations', group: 'Security', label: 'Integrations & health', description: 'Providers, webhooks, devices', permission: 'integrations.manage', web: '/admin/integrations' },
  { key: 'structure', group: 'Security', label: 'Organization structure', description: 'Company, legal entities, regions, food halls, merchants, brands', permission: 'merchants.read', web: '/admin/structure', mobile: '/ops/structure' },
  { key: 'staff', group: 'Security', label: 'Staff & access', description: 'Roles, scopes, sessions, MFA, emergency access', permission: 'security.read', web: '/admin/security', mobile: '/ops/security' },
  { key: 'audit', group: 'Security', label: 'Audit history', description: 'Who changed what, when and why', permission: 'security.read', web: '/admin/audit', mobile: '/ops/audit' },
  { key: 'settings', group: 'Security', label: 'Platform settings', description: 'Settings, thresholds, SSO and session policy', permission: 'settings.manage', web: '/admin/settings' },
];

export function modulesFor(permissions: readonly string[]): AdminModule[] {
  return ADMIN_MODULES.filter((m) => permissions.includes(m.permission));
}

/** Merchant workspace pages each member role may open (managers and owners see everything). */
export const MERCHANT_PAGE_ROLES: Record<string, Role[]> = {
  '/merchant': ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF'],
  '/merchant/orders': ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'PACKER'],
  '/merchant/kitchen': ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'KITCHEN', 'PACKER'],
  '/merchant/host': ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF', 'HOST'],
  '/merchant/dispatch': ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'DISPATCHER'],
  '/merchant/shift': ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF'],
  '/merchant/support': ['MERCHANT_OWNER', 'MERCHANT_MANAGER', 'MERCHANT_STAFF'],
};
/** Pages not listed above are for owners and managers only. */
export function merchantPageAllowed(path: string, roles: readonly string[]): boolean {
  if (roles.includes('MERCHANT_OWNER') || roles.includes('MERCHANT_MANAGER') || roles.includes('PLATFORM_ADMIN')) return true;
  const allowed = MERCHANT_PAGE_ROLES[path];
  return !!allowed && roles.some((r) => (allowed as string[]).includes(r));
}

/** Approval request kinds handled by the approval engine. */
export const APPROVAL_KINDS = {
  REFUND: { label: 'Refund', permission: 'support.manage' },
  BANK_ACCOUNT_CHANGE: { label: 'Bank account change', permission: 'finance.approve' },
  SETTING_CHANGE: { label: 'Sensitive setting', permission: 'settings.manage' },
  PURCHASE_ORDER: { label: 'Supplier purchase order', permission: 'kitchens.manage' },
  PRICE_CHANGE: { label: 'Price change', permission: 'catalog.manage' },
  PAYOUT_RELEASE: { label: 'Payout release', permission: 'finance.approve' },
} as const satisfies Record<string, { label: string; permission: Permission }>;
export type ApprovalKind = keyof typeof APPROVAL_KINDS;

export interface ApprovalRequestDto {
  id: string;
  kind: ApprovalKind;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELED' | 'EXPIRED' | 'EXECUTED' | 'FAILED';
  summary: string;
  organizationId: string | null;
  subjectType: string;
  subjectId: string;
  amountCents: number | null;
  reason: string;
  requestedById: string;
  requestedByEmail?: string | null;
  requiredApprovals: number;
  approvals: { userId: string; email?: string; at: string; note?: string | null }[];
  decisionNote: string | null;
  result: unknown;
  expiresAt: string | null;
  createdAt: string;
}

/** Default approval thresholds (cents, or basis points for price changes). Overridden by setting `approvals.thresholds`. */
export const DEFAULT_APPROVAL_THRESHOLDS = {
  /** refunds above this need approval, per staff role (cents); merchant members use their membership limit */
  refundByRole: { SUPPORT: 5000, OPERATIONS: 10000, FINANCE: 50000, EXECUTIVE: 100000 } as Record<string, number>,
  /** a menu price change larger than this many basis points needs approval; 0 turns it off */
  priceChangeBps: 0,
  /** supplier purchase orders above this need approval; 0 turns it off */
  purchaseOrderCents: 100000,
  /** payouts above this need a second person */
  payoutCents: 500000,
};
