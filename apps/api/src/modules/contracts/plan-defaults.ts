/**
 * Starting catalog, seeded once when the `plans` table is empty. After that, everything here is edited from
 * Admin → Plans; this file is not read again.
 */
import type { FeeRuleDto, ProductLine } from '@gutad/shared';

export const DEFAULT_FEATURES: { key: string; name: string; description: string; kind: 'BOOLEAN' | 'LIMIT'; productLine: 'ORDERING' | 'RESERVATIONS' | 'ALL' }[] = [
  { key: 'ordering', name: 'Online ordering', description: 'Pickup orders from your Gutad page and ordering link', kind: 'BOOLEAN', productLine: 'ORDERING' },
  { key: 'delivery', name: 'Delivery', description: 'Delivery by Gutad couriers and partners', kind: 'BOOLEAN', productLine: 'ORDERING' },
  { key: 'marketplace_listing', name: 'Gutad marketplace listing', description: 'Appear in Gutad search and the app', kind: 'BOOLEAN', productLine: 'ALL' },
  { key: 'marketplace_boost', name: 'Marketplace boost', description: 'Higher placement in Gutad search', kind: 'BOOLEAN', productLine: 'ORDERING' },
  { key: 'qr_ordering', name: 'QR ordering', description: 'Table and counter QR codes', kind: 'BOOLEAN', productLine: 'ORDERING' },
  { key: 'branded_site', name: 'Branded ordering site', description: 'Commission-free ordering on your own branded site', kind: 'BOOLEAN', productLine: 'ORDERING' },
  { key: 'group_orders', name: 'Group & catering orders', description: 'Team orders, budgets and catering trays', kind: 'BOOLEAN', productLine: 'ORDERING' },
  { key: 'reservations', name: 'Reservations', description: 'Online table bookings with real availability', kind: 'BOOLEAN', productLine: 'RESERVATIONS' },
  { key: 'booking_widget', name: 'Website booking widget', description: 'Commission-free bookings on your own website', kind: 'BOOLEAN', productLine: 'RESERVATIONS' },
  { key: 'waitlist', name: 'Waitlist', description: 'Walk-in waitlist with text alerts', kind: 'BOOLEAN', productLine: 'RESERVATIONS' },
  { key: 'floor_plan', name: 'Floor plan & table management', description: 'Rooms, tables, combinations and host stand', kind: 'BOOLEAN', productLine: 'RESERVATIONS' },
  { key: 'experiences', name: 'Ticketed experiences', description: 'Prepaid tastings, classes and events', kind: 'BOOLEAN', productLine: 'RESERVATIONS' },
  { key: 'private_events', name: 'Private events', description: 'Inquiries, proposals and deposits', kind: 'BOOLEAN', productLine: 'RESERVATIONS' },
  { key: 'ads', name: 'Sponsored placements', description: 'Pay-per-click ads in Gutad search', kind: 'BOOLEAN', productLine: 'ALL' },
  { key: 'advanced_analytics', name: 'Advanced analytics', description: 'Guest insights, retention and CSV exports', kind: 'BOOLEAN', productLine: 'ALL' },
  { key: 'pos_integration', name: 'POS integration', description: 'Menu sync and order injection with your POS', kind: 'BOOLEAN', productLine: 'ALL' },
  { key: 'locations', name: 'Locations included', description: 'Maximum locations on the plan', kind: 'LIMIT', productLine: 'ALL' },
  { key: 'team_members', name: 'Team members', description: 'Maximum staff accounts', kind: 'LIMIT', productLine: 'ALL' },
];

const fee = (type: FeeRuleDto['type'], channel: string, fulfillment: string, bps = 0, cents = 0, capCents: number | null = null): FeeRuleDto => ({ type, channel, fulfillment, bps, cents, capCents });

const PROCESSING = fee('PROCESSING', 'ANY', 'ANY', 295, 29);
const orderingCommission = (deliveryBps: number) => [
  fee('COMMISSION', 'NETWORK', 'DELIVERY', deliveryBps),
  fee('COMMISSION', 'NETWORK', 'PICKUP', 600),
  fee('COMMISSION', 'NETWORK', 'ANY', deliveryBps),
  fee('COMMISSION', 'ANY', 'ANY', 0),
];
const reservationFees = (networkCoverCents: number) => [fee('COVER_FEE', 'NETWORK', 'ANY', 0, networkCoverCents), fee('COVER_FEE', 'ANY', 'ANY', 0, 0), fee('PREPAID_SERVICE_FEE', 'ANY', 'ANY', 200)];

const ORDERING_BASE = { ordering: true, delivery: true, marketplace_listing: true, qr_ordering: true };
const RES_BASE = { reservations: true, booking_widget: true, waitlist: true, experiences: true, marketplace_listing: true };

export const DEFAULT_PLANS: {
  code: string; name: string; productLine: ProductLine; tagline: string; description: string; highlight?: boolean; sortOrder: number;
  subscriptionCents: number; fees: FeeRuleDto[]; features: Record<string, boolean | number>;
}[] = [
  { code: 'DIRECT_FREE', name: 'Direct (free listing)', productLine: 'ORDERING', sortOrder: 10, tagline: 'Start selling with no monthly fee', description: 'List on Gutad and take orders on your own link. Pay commission only on marketplace orders.', subscriptionCents: 0, fees: [...orderingCommission(1500), PROCESSING], features: { ...ORDERING_BASE, locations: 1, team_members: 3 } },
  { code: 'DIRECT_PRO', name: 'Direct Pro', productLine: 'ORDERING', sortOrder: 20, highlight: true, tagline: 'Your own branded ordering, commission-free', description: 'Everything in Direct plus a branded site, group orders, POS integration and analytics.', subscriptionCents: 22900, fees: [...orderingCommission(1500), PROCESSING], features: { ...ORDERING_BASE, branded_site: true, group_orders: true, pos_integration: true, advanced_analytics: true, locations: 3, team_members: 15 } },
  { code: 'MARKETPLACE_PLUS', name: 'Marketplace Plus', productLine: 'ORDERING', sortOrder: 30, tagline: 'More reach on the Gutad marketplace', description: 'Higher placement in Gutad search and $1 per order toward delivery, for a higher marketplace commission.', subscriptionCents: 0, fees: [...orderingCommission(2000), fee('DELIVERY_SUBSIDY', 'ANY', 'DELIVERY', 0, 100), PROCESSING], features: { ...ORDERING_BASE, marketplace_boost: true, locations: 1, team_members: 5 } },
  { code: 'RESERVATIONS_CORE', name: 'Reservations Core', productLine: 'RESERVATIONS', sortOrder: 10, tagline: 'Online bookings and waitlist', description: 'Take bookings on Gutad and your own website, run a waitlist and sell experiences.', subscriptionCents: 14900, fees: [...reservationFees(150), PROCESSING], features: { ...RES_BASE, locations: 1, team_members: 5 } },
  { code: 'RESERVATIONS_PRO', name: 'Reservations Pro', productLine: 'RESERVATIONS', sortOrder: 20, highlight: true, tagline: 'Full table management', description: 'Everything in Core plus floor plans and table management, private events, analytics and a lower cover fee.', subscriptionCents: 29900, fees: [...reservationFees(100), PROCESSING], features: { ...RES_BASE, floor_plan: true, private_events: true, advanced_analytics: true, pos_integration: true, locations: 3, team_members: 25 } },
  { code: 'FULL_SUITE', name: 'Full suite', productLine: 'SUITE', sortOrder: 10, highlight: true, tagline: 'Ordering and reservations, every feature', description: 'All ordering and reservations features, sponsored placements, analytics and POS integration.', subscriptionCents: 49900, fees: [...orderingCommission(1500), ...reservationFees(100), PROCESSING], features: { ...ORDERING_BASE, ...RES_BASE, branded_site: true, group_orders: true, marketplace_boost: true, floor_plan: true, private_events: true, ads: true, advanced_analytics: true, pos_integration: true, locations: 10, team_members: 50 } },
];
